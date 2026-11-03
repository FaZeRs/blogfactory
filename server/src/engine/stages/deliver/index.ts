import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { articleRuns, generationLogs, jobs, posts, sites } from "../../../db/schema.js";
import { currentPostRevision, setPostEditorialState } from "../../../services/post-revisions.js";
import { enqueueSeoMetadata, kickSeoMetadataWorker } from "../../../services/seo-metadata.js";
import type { Stage } from "../../runtime/stage.js";
import { StageInputError } from "../../types.js";
import type { DraftOutput } from "../draft/schema.js";
import type { GatesOutput } from "../gates/schema.js";
import { findStageOutput, latestDraft, modelFor, renderArticle } from "../shared.js";
import type { DeliverOutput } from "./schema.js";

export type DeliverInput = { draft: DraftOutput; escalated: boolean; reason: string | null };

export const deliverStage: Stage<DeliverInput, DeliverOutput> = {
  key: "deliver",
  promptVersion: "deliver@2026-11-03.1",
  async input({ run }) {
    const [draft, gates] = await Promise.all([latestDraft(run), findStageOutput<GatesOutput>(run, "gates")]);
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
      const { markdown } = await renderArticle(run, input.draft.markdown);
      [post] = await db.insert(posts).values({
        userId: run.userId,
        siteId: run.siteId,
        preferredIntegrationId: run.preferredIntegrationId,
        title: input.draft.title,
        content: markdown,
        status: "draft",
        sourceType: run.sourceType,
        jobId: run.jobId,
        modelId: modelFor(run, "draft"),
        summary: input.draft.description,
        publishingMetadata: { engine: { runId: run.id, mode: run.mode, escalated: input.escalated } },
      }).returning();
      await db.insert(generationLogs).values({
        userId: run.userId,
        postId: post.id,
        usageType: "text",
        modelId: post.modelId,
        provider: post.modelId?.split("/")[0],
        status: "success",
        cost: run.spentUsd,
        sessionId: run.jobId,
        responseData: { engine: { runId: run.id, mode: run.mode } },
      });
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

    const output = { postId: post.id, created: !existing, escalated: input.escalated };
    return { output, next: input.escalated ? { type: "escalate", reason: input.reason ?? "Gates still failing" } : { type: "done" } };
  },
};
