import { and, desc, eq, gt, notInArray, sql } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { articleGateResults, articleRuns, jobs, postRevisions, postTranslations, posts, sites } from "../../../db/schema.js";
import { currentPostRevision, setPostEditorialState, updatePostWithRevision } from "../../../services/post-revisions.js";
import { enqueueSeoMetadata, kickSeoMetadataWorker } from "../../../services/seo-metadata.js";
import { coverPromptDraft, queueCoverRequests } from "../../../services/cover-tools.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { parseModelId } from "../../adapters/subscription.js";
import { appendProvenance, provenanceTag } from "../../components/provenance.js";
import { componentProfile } from "../../profile.js";
import type { ArticleRunRow, Stage } from "../../runtime/stage.js";
import { StageInputError } from "../../types.js";
import type { DraftOutput } from "../draft/schema.js";
import type { GatesOutput } from "../gates/schema.js";
import { findStageOutput, latestDraft, modelFor, renderArticle } from "../shared.js";
import type { LocalizeOutput } from "../localize/schema.js";
import type { DeliverOutput } from "./schema.js";

export type DeliverInput = { draft: DraftOutput; escalated: boolean; reason: string | null };

/** The Lindevo provenance box: sources cited, checks whose latest result passed, the delivery date and the writer models. */
async function provenanceFor(run: ArticleRunRow, cited: string[], evidence: { id: string; sourceId: string; verified: boolean }[], now: Date) {
  const rows = await db.select({ gate: articleGateResults.gate, passed: articleGateResults.passed }).from(articleGateResults)
    .where(and(eq(articleGateResults.runId, run.id), eq(articleGateResults.userId, run.userId)))
    .orderBy(desc(articleGateResults.createdAt));
  // The gates and the review count attempts separately, so each check's newest row is its final result.
  const seen = new Set<string>();
  const latest = rows.filter((r) => !seen.has(r.gate) && !!seen.add(r.gate));
  const roles = run.reviseCount > 0 ? (["draft", "revise"] as const) : (["draft"] as const);
  return provenanceTag({
    sources: new Set(evidence.filter((e) => e.verified && cited.includes(e.id)).map((e) => e.sourceId)).size,
    checks: latest.filter((r) => r.passed).length,
    reviewed: now.toISOString().slice(0, 10),
    models: [...new Set(roles.map((role) => modelDisplayName(modelFor(run, role))))],
  });
}

/** "anthropic/claude-sonnet-5.5" and "claude-code:claude-sonnet-5-5" read as "Claude Sonnet 5.5". */
export const modelDisplayName = (id: string) => {
  const { provider, model, fallback } = parseModelId(id);
  // A CLI model id writes the version with a dash ("claude-opus-5-5").
  const name = fallback ?? (provider ? model.replace(/(\d)-(?=\d)/g, "$1.") : model);
  return (name.split("/").pop() ?? name).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

export const EDITED_WHILE_REFRESHING = "The post was edited while it was being refreshed. The refresh is saved as a new revision; the earlier edits are in the revision history.";

/** Writes the run's draft as a new revision of the post being refreshed. The post keeps its slug, its publications and its translations (which go stale). */
async function refreshPost(run: ArticleRunRow, target: typeof posts.$inferSelect, input: DeliverInput, ctx: { deps: { now(): Date } }) {
  const engine = ((target.publishingMetadata as { engine?: Record<string, unknown> } | null)?.engine ?? {});
  // A retry after a crash finds the revision it already wrote.
  if (engine.refreshRunId === run.id) return { post: target, note: null, written: false };
  // Edits made by a person or an agent since the run started (not background metadata, image or refresh writes).
  const [edited] = await db.select({ id: postRevisions.id }).from(postRevisions).where(and(
    eq(postRevisions.userId, run.userId), eq(postRevisions.postId, target.id), gt(postRevisions.createdAt, run.createdAt),
    notInArray(postRevisions.source, ["initial", "system", "image", "publish_metadata", "refresh"]),
  )).limit(1);
  const { markdown: rendered, evidence } = await renderArticle(run, input.draft.markdown);
  const markdown = componentProfile(run) === "lindevo" ? appendProvenance(rendered, await provenanceFor(run, input.draft.citedClaimIds, evidence, ctx.deps.now())) : rendered;
  const { post } = await updatePostWithRevision({
    userId: run.userId, postId: target.id, expectedUpdatedAt: target.updatedAt, source: "refresh",
    changes: {
      title: input.draft.title, content: markdown.trimEnd(), summary: input.draft.description,
      publishingMetadata: { ...(target.publishingMetadata as object | null), engine: { ...engine, refreshRunId: run.id } },
    },
  });
  // The URL and its ranking history are kept: a regenerated slug must not replace the published one.
  const seo = post.seoMetadata as { slug?: unknown; provenance?: Record<string, unknown> } | null;
  if (seo && typeof seo.slug === "string" && seo.slug) {
    await db.update(posts).set({ seoMetadata: { ...seo, provenance: { ...seo.provenance, slug: "manual" } } })
      .where(and(eq(posts.id, post.id), eq(posts.userId, run.userId)));
  }
  return { post, note: edited ? EDITED_WHILE_REFRESHING : null, written: true };
}

export const deliverStage: Stage<DeliverInput, DeliverOutput> = {
  key: "deliver",
  promptVersion: "deliver@2026-11-05.1",
  async input({ run }) {
    const [draft, gates] = await Promise.all([latestDraft(run), findStageOutput<GatesOutput>(run, "gates", "review")]);
    return { draft, escalated: gates?.output.escalated ?? false, reason: gates?.output.reason ?? null };
  },
  async run(input, ctx) {
    const { run } = ctx;
    const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, run.siteId), eq(sites.userId, run.userId))).limit(1);
    if (!site) throw new StageInputError("Site no longer exists");

    // A retry after a crash finds the post it already made; a human edit on it is never overwritten.
    const [existing] = await db.select().from(posts).where(and(
      eq(posts.userId, run.userId),
      sql`${posts.publishingMetadata}->'engine'->>'runId' = ${run.id}`,
    )).limit(1);

    // A refresh run re-drafts a post that already exists; a post that is gone fails the run rather than creating a second one.
    const refreshId = (run.settings as { refreshPostId?: string } | null)?.refreshPostId;
    let note: string | null = null;
    let refreshWritten = false;
    let post = existing;
    if (refreshId) {
      const [target] = await db.select().from(posts).where(and(eq(posts.id, refreshId), eq(posts.userId, run.userId), eq(posts.siteId, run.siteId))).limit(1);
      if (!target) throw new StageInputError("The post to refresh no longer exists");
      const refreshed = await refreshPost(run, target, input, ctx);
      post = refreshed.post;
      note = refreshed.note;
      refreshWritten = refreshed.written;
    } else if (!post) {
      const { markdown: rendered, evidence } = await renderArticle(run, input.draft.markdown);
      const markdown = componentProfile(run) === "lindevo" ? appendProvenance(rendered, await provenanceFor(run, input.draft.citedClaimIds, evidence, ctx.deps.now())) : rendered;
      [post] = await db.insert(posts).values({
        userId: run.userId,
        siteId: run.siteId,
        preferredIntegrationId: run.preferredIntegrationId,
        title: input.draft.title,
        // The editor trims trailing whitespace; storing it would make every fresh draft look unsaved.
        content: markdown.trimEnd(),
        status: "draft",
        sourceType: run.sourceType,
        jobId: run.jobId,
        modelId: modelFor(run, "draft"),
        summary: input.draft.description,
        publishingMetadata: { engine: { runId: run.id, mode: run.mode, escalated: input.escalated } },
      }).returning();
    }

    // The insert trigger wrote revision 1; the post enters review on that revision. A refresh goes back to review on its new revision.
    const revision = await currentPostRevision(run.userId, post.id);
    // A retry after a crash between the write and this step finds the refresh revision still in draft.
    if (refreshWritten || (refreshId && post.editorialState === "draft" && revision?.source === "refresh")) {
      await setPostEditorialState({ userId: run.userId, postId: post.id, state: "in_review", expectedRevisionId: revision!.id });
    } else if (!refreshId && post.editorialState === "draft" && revision?.revisionNumber === 1) {
      await setPostEditorialState({ userId: run.userId, postId: post.id, state: "in_review", expectedRevisionId: revision.id });
    }
    await db.update(articleRuns).set({ postId: post.id }).where(and(eq(articleRuns.id, run.id), eq(articleRuns.userId, run.userId)));
    if (run.jobId) {
      await db.update(jobs).set({ resultPostIds: [post.id] }).where(and(eq(jobs.id, run.jobId), eq(jobs.userId, run.userId)));
    }
    // The translations were made from the draft as delivered, which is revision 1. On a retry after someone edited the
    // post, the current revision is newer, and pinning to it would hide that the translations are now stale.
    // (A refresh pins new translations to its own revision; the existing ones keep theirs and so are stale.)
    const firstRevision = refreshId ? revision : revision?.revisionNumber === 1 ? revision : (await db.select({ id: postRevisions.id }).from(postRevisions)
      .where(and(eq(postRevisions.userId, run.userId), eq(postRevisions.postId, post.id), eq(postRevisions.revisionNumber, 1))).limit(1))[0];
    // A retry keeps rows that exist (a person may have edited them).
    try {
      const localized = await findStageOutput<LocalizeOutput>(run, "localize");
      const made = (localized?.output.locales ?? []).filter((l) => l.status !== "failed");
      // The translation was made before the English got its provenance tag; Lindevo's parity lint needs the same last component in both.
      const provenance = /<provenance\b[^>]*><\/provenance>\s*$/.exec(post.content)?.[0].trim();
      if (made.length) {
        await db.insert(postTranslations).values(made.map((l) => {
          const content = provenance ? appendProvenance(l.content, provenance).trimEnd() : l.content;
          return {
          userId: run.userId, siteId: run.siteId, postId: post.id, locale: l.locale,
          // engineContent: what the engine wrote, so a later hand edit becomes a learning signal.
          title: l.title, slug: l.slug, description: l.description, content, engineContent: content, imageAlt: l.imageAlt, keyword: l.keyword,
          status: l.status === "ready" ? "ready" : "needs_review", findings: l.findings, sourceRevisionId: firstRevision?.id ?? null, costUsd: l.costUsd,
          };
        })).onConflictDoNothing();
      }
    } catch (err) {
      // The English draft exists and is reviewable; the translation can be made again from the editor.
      console.warn("[engine] translation save failed:", err instanceof Error ? err.message : err);
    }
    try {
      const seo = await enqueueSeoMetadata({ userId: run.userId, postId: post.id, trigger: "generation" });
      if (seo.queued) await kickSeoMetadataWorker(run.userId);
    } catch (err) {
      // The post exists and is reviewable; metadata can be regenerated from the editor.
      console.warn("[engine] SEO metadata enqueue failed:", err instanceof Error ? err.message : err);
    }

    // Only a newly created post without a cover gets one; a retry or a human-chosen cover is left alone.
    if (!existing && !refreshId && !post.coverImageUrl && (run.settings as { cover?: boolean } | null)?.cover) {
      try {
        const settings = await getEffectiveSettings(run.userId, run.siteId);
        if (settings.imageModel) {
          await queueCoverRequests({
            userId: run.userId, post, settings: { ...settings, imageModel: settings.imageModel },
            prompt: coverPromptDraft({ title: post.title, content: post.content, preset: "site_default", settings }),
          });
        }
      } catch (err) {
        console.warn("[engine] cover enqueue failed:", err instanceof Error ? err.message : err);
      }
    }

    const output = { postId: post.id, created: !existing && !refreshId, escalated: input.escalated, ...(refreshId ? { refreshed: true, note } : {}) };
    return { output, next: input.escalated ? { type: "escalate", reason: input.reason ?? "Gates still failing" } : { type: "done" } };
  },
};
