import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { postTranslations, posts } from "../db/schema.js";
import { engineAiEndpoint } from "../engine/adapters/llm.js";
import { ApiError, readJsonObject, safeError } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { persistentBackgroundExecution } from "../services/background-drain.js";
import { SLUG_MAX, type Finding } from "../services/localization/checks.js";
import { LOCALE_RE } from "../services/localization/settings.js";
import { beginTranslation, runTranslation } from "../services/localization/translate-post.js";
import { currentPostRevision } from "../services/post-revisions.js";
import { staleSourceRevisions } from "../services/localization/stale.js";
import { UUID, validation } from "./owned-site.js";

export const postTranslationsRoutes = new Hono();

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function serializeTranslation(row: typeof postTranslations.$inferSelect, stale: Set<string | null>) {
  return {
    locale: row.locale,
    status: row.status,
    // A placeholder that is still being made has no text to be out of date.
    stale: row.status !== "running" && stale.has(row.sourceRevisionId),
    title: row.title,
    slug: row.slug,
    description: row.description,
    content: row.content,
    imageAlt: row.imageAlt,
    keyword: row.keyword,
    findings: row.findings as Finding[],
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedPost(c: Parameters<typeof getUserId>[0], id: string) {
  const userId = getUserId(c);
  if (!UUID.test(id)) throw new ApiError(404, "not_found", "Post not found");
  const [post] = await db.select({ id: posts.id, siteId: posts.siteId }).from(posts).where(and(eq(posts.id, id), eq(posts.userId, userId))).limit(1);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  return { userId, post };
}

const localeParam = (locale: string) => {
  if (!LOCALE_RE.test(locale)) throw validation("locale", "Use a language code such as lv or pt-BR");
  return locale;
};

postTranslationsRoutes.get("/:id/translations", async (c) => {
  const { userId, post } = await ownedPost(c, c.req.param("id"));
  if (!post.siteId) return c.json({ translations: [] });
  const [rows, revision] = await Promise.all([
    db.select().from(postTranslations).where(and(eq(postTranslations.userId, userId), eq(postTranslations.siteId, post.siteId), eq(postTranslations.postId, post.id))),
    currentPostRevision(userId, post.id),
  ]);
  const stale = await staleSourceRevisions(userId, rows.map((r) => r.sourceRevisionId), revision);
  return c.json({ translations: rows.map((r) => serializeTranslation(r, stale)) });
});

postTranslationsRoutes.put("/:id/translations/:locale", async (c) => {
  const { userId, post } = await ownedPost(c, c.req.param("id"));
  const locale = localeParam(c.req.param("locale"));
  const body = await readJsonObject(c);
  const text = (field: string, max: number, required = true) => {
    const v = body[field];
    if (typeof v !== "string" || (required && !v.trim())) throw validation(field, `${field} is required`);
    if (v.length > max) throw validation(field, `${field} is limited to ${max} characters`);
    return v;
  };
  const title = text("title", 200).trim();
  const slug = text("slug", SLUG_MAX).trim();
  if (!SLUG_RE.test(slug)) throw validation("slug", "Use lowercase letters, digits and single hyphens");
  const description = text("description", 500, false).trim();
  const content = text("content", 200_000);
  const imageAlt = text("imageAlt", 300, false).trim();
  const expected = typeof body.expectedUpdatedAt === "string" ? new Date(body.expectedUpdatedAt) : null;
  if (!expected || Number.isNaN(expected.getTime())) throw validation("expectedUpdatedAt", "expectedUpdatedAt is required");
  if (!post.siteId) throw new ApiError(404, "not_found", "Translation not found");

  // The client holds the version in milliseconds; a row stamped by the database has microseconds.
  const scope = and(eq(postTranslations.userId, userId), eq(postTranslations.siteId, post.siteId), eq(postTranslations.postId, post.id), eq(postTranslations.locale, locale));
  const [row] = await db.update(postTranslations)
    .set({ title, slug, description, content, imageAlt, status: "edited", findings: [], updatedAt: new Date() })
    .where(and(scope, sql`date_trunc('milliseconds', ${postTranslations.updatedAt}) = ${expected.toISOString()}::timestamptz`, ne(postTranslations.status, "running"))).returning();
  if (row) return c.json({ translation: serializeTranslation(row, await staleSourceRevisions(userId, [row.sourceRevisionId], await currentPostRevision(userId, post.id))) });
  const [current] = await db.select({ status: postTranslations.status }).from(postTranslations).where(scope).limit(1);
  if (!current) throw new ApiError(404, "not_found", "Translation not found");
  throw new ApiError(409, "conflict", current.status === "running" ? "A translation is running; wait for it to finish" : "This translation changed since you opened it. Reload and try again.");
});

postTranslationsRoutes.post("/:id/translations/:locale/run", async (c) => {
  const { userId, post } = await ownedPost(c, c.req.param("id"));
  const locale = localeParam(c.req.param("locale"));
  // A serverless function is cut off long before a translation ends; only the persistent worker host can carry it.
  if (!persistentBackgroundExecution()) throw new ApiError(400, "validation_error", "Translating needs the persistent background worker (BACKGROUND_EXECUTION_MODE=worker).");
  if (!engineAiEndpoint(process.env, await getOpenRouterKey(userId))) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
  const claim = await beginTranslation(userId, post.id, locale);
  waitUntil(runTranslation(claim).catch((error) => { console.error("[localize] Translation failed", safeError(error)); }));
  return c.json({ started: true }, 202);
});

const REQUESTS_MIN = 10;
const REQUESTS_MAX = 4000;

/** Revises an existing translation to the owner's comments (a native reviewer's corrections), in the background. */
postTranslationsRoutes.post("/:id/translations/:locale/revise", async (c) => {
  const { userId, post } = await ownedPost(c, c.req.param("id"));
  const locale = localeParam(c.req.param("locale"));
  const body = await readJsonObject(c);
  const comments = typeof body.comments === "string" ? body.comments.trim() : "";
  if (comments.length < REQUESTS_MIN || comments.length > REQUESTS_MAX) throw validation("comments", `Write ${REQUESTS_MIN}–${REQUESTS_MAX} characters of corrections`);
  if (!persistentBackgroundExecution()) throw new ApiError(400, "validation_error", "Revising needs the persistent background worker (BACKGROUND_EXECUTION_MODE=worker).");
  if (!engineAiEndpoint(process.env, await getOpenRouterKey(userId))) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
  const [existing] = await db.select({ content: postTranslations.content, status: postTranslations.status }).from(postTranslations)
    .where(and(eq(postTranslations.userId, userId), eq(postTranslations.postId, post.id), eq(postTranslations.locale, locale))).limit(1);
  if (!existing || existing.status !== "running" && existing.content.trim() === "") throw new ApiError(404, "not_found", "There is no translation to revise yet. Translate the post first.");
  const claim = await beginTranslation(userId, post.id, locale);
  waitUntil(runTranslation(claim, { requests: comments }).catch((error) => { console.error("[localize] Translation revision failed", safeError(error)); }));
  return c.json({ started: true }, 202);
});
