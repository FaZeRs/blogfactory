import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { articleGateResults, articleRuns, jobs, posts, sites } from "../../../db/schema.js";
import { currentPostRevision, setPostEditorialState } from "../../../services/post-revisions.js";
import { enqueueSeoMetadata, kickSeoMetadataWorker } from "../../../services/seo-metadata.js";
import { coverPromptDraft, queueCoverRequests } from "../../../services/cover-tools.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { appendProvenance, provenanceTag } from "../../components/provenance.js";
import { componentProfile } from "../../profile.js";
import type { ArticleRunRow, Stage } from "../../runtime/stage.js";
import { StageInputError } from "../../types.js";
import type { DraftOutput } from "../draft/schema.js";
import type { GatesOutput } from "../gates/schema.js";
import { findStageOutput, latestDraft, modelFor, renderArticle } from "../shared.js";
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

/** "anthropic/claude-sonnet-5.5" reads as "Claude Sonnet 5.5". */
export const modelDisplayName = (id: string) =>
  (id.split("/").pop() ?? id).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

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

    let post = existing;
    if (!post) {
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

    // The insert trigger wrote revision 1; the post enters review on that revision.
    const revision = await currentPostRevision(run.userId, post.id);
    if (post.editorialState === "draft" && revision?.revisionNumber === 1) {
      await setPostEditorialState({ userId: run.userId, postId: post.id, state: "in_review", expectedRevisionId: revision.id });
    }
    await db.update(articleRuns).set({ postId: post.id }).where(and(eq(articleRuns.id, run.id), eq(articleRuns.userId, run.userId)));
    if (run.jobId) {
      await db.update(jobs).set({ resultPostIds: [post.id] }).where(and(eq(jobs.id, run.jobId), eq(jobs.userId, run.userId)));
    }
    try {
      const seo = await enqueueSeoMetadata({ userId: run.userId, postId: post.id, trigger: "generation" });
      if (seo.queued) await kickSeoMetadataWorker(run.userId);
    } catch (err) {
      // The post exists and is reviewable; metadata can be regenerated from the editor.
      console.warn("[engine] SEO metadata enqueue failed:", err instanceof Error ? err.message : err);
    }

    // Only a newly created post without a cover gets one; a retry or a human-chosen cover is left alone.
    if (!existing && !post.coverImageUrl && (run.settings as { cover?: boolean } | null)?.cover) {
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

    const output = { postId: post.id, created: !existing, escalated: input.escalated };
    return { output, next: input.escalated ? { type: "escalate", reason: input.reason ?? "Gates still failing" } : { type: "done" } };
  },
};
