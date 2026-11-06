import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { ApiError, readJsonObject } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { serializePostRevision } from "../services/post-revisions.js";
import { COMMENTS_MAX, COMMENTS_MIN, reviseWithComments, type ReviseDeps } from "../services/post-revise-comments.js";
import { drainSeoMetadata, enqueueSeoMetadata } from "../services/seo-metadata.js";

const invalid = (field: string, message: string) => new ApiError(400, "validation_error", message, [{ field, message }]);

/** The model deps are injectable so self-tests never call a provider. */
export function createPostReviseRoutes(deps: { reviseDeps?: ReviseDeps } = {}) {
  return new Hono().post("/:id/revise-with-comments", async (c) => {
    const userId = getUserId(c);
    const id = c.req.param("id");
    const body = await readJsonObject(c);
    const comments = typeof body.comments === "string" ? body.comments.trim() : "";
    if (comments.length < COMMENTS_MIN || comments.length > COMMENTS_MAX) throw invalid("comments", `Comments must be ${COMMENTS_MIN} to ${COMMENTS_MAX} characters`);
    const expectedUpdatedAt = new Date(typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : NaN);
    if (Number.isNaN(expectedUpdatedAt.getTime())) throw invalid("expectedUpdatedAt", "expectedUpdatedAt must be an ISO timestamp");

    const result = await reviseWithComments({ userId, postId: id, comments, expectedUpdatedAt, deps: deps.reviseDeps, signal: c.req.raw.signal });
    // Same follow-up as a manual save: the new text needs fresh canonical SEO.
    const seoJob = result.changed ? await enqueueSeoMetadata({ userId, postId: id, trigger: "save" }) : null;
    if (seoJob?.queued) waitUntil(drainSeoMetadata(userId, 1));
    const [fresh] = await db.select({ seoMetadata: posts.seoMetadata }).from(posts).where(and(eq(posts.id, id), eq(posts.userId, userId))).limit(1);
    return c.json({
      ...result.post,
      seo_metadata: fresh?.seoMetadata || null,
      seo_job_id: seoJob?.jobId || null,
      current_revision: result.revision ? serializePostRevision(result.revision) : null,
      changed: result.changed,
    });
  });
}
