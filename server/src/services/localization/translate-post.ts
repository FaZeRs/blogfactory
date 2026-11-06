import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { imageAssets, postRevisions, postTranslations, posts } from "../../db/schema.js";
import { createDataForSeoClient } from "../../engine/adapters/dataforseo.js";
import { engineAiEndpoint } from "../../engine/adapters/llm.js";
import { parseEngineSettings, resolveRunSettings } from "../../engine/modes.js";
import { resolveDestinationProvider } from "../../engine/profile.js";
import { dataForSeoSpend } from "../../engine/runtime/deps.js";
import { ApiError } from "../../http/error-contract.js";
import { checkAccountGuardrails } from "../account-guardrails.js";
import { getOpenRouterKey } from "../api-keys.js";
import { resolveEngineModel, userEngineLlm } from "../engine-llm.js";
import { currentPostRevision, postRevisionSnapshot } from "../post-revisions.js";
import { seoMetadata } from "../seo-metadata.js";
import { getEffectiveSettings } from "../user-settings.js";
import type { Finding } from "./checks.js";
import { type LocalizeDeps, type LocalizeResult, localizeArticle, summarizeChange } from "./localize.js";
import { type LocaleSetting, getLocalization } from "./settings.js";

type TranslationRow = typeof postTranslations.$inferSelect;

/**
 * The running guard is the translation row itself: a row with `status = 'running'` means a translation is being made, and it is
 * claimed in one transaction (insert, or lock the row and flip it), so two workers or two requests cannot both start one.
 * A process that dies leaves the row running, so a claim older than this counts as dead and may be taken over.
 */
export const RUNNING_STALE_MS = 30 * 60_000;

/** A claimed translation: the row is `running` until `runTranslation` ends it. */
export type TranslationClaim = {
  userId: string;
  siteId: string;
  post: typeof posts.$inferSelect;
  locale: LocaleSetting;
  /** The row as it was before the claim (null when there was none); restored if the run fails. */
  prior: TranslationRow | null;
  /** The post revision the translation is made from. */
  revisionId: string | null;
  /** That revision's own English text, so the text translated and the revision recorded always match. */
  english: { title: string; summary: string | null; content: string };
};

/**
 * Validates the post and the locale and takes the running guard. Throws `ApiError` 404 (no such post for this user), 400
 * (the post has no site, or the locale is not enabled for it) and 409 (a translation of this post and locale is running).
 */
export async function beginTranslation(userId: string, postId: string, locale: string, now = new Date()): Promise<TranslationClaim> {
  const [post] = await db.select().from(posts).where(and(eq(posts.id, postId), eq(posts.userId, userId))).limit(1);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  if (!post.siteId) throw new ApiError(400, "validation_error", "This post has no site, so it has no languages");
  const settings = await getLocalization(userId, post.siteId);
  const target = settings.enabled ? settings.locales.find((l) => l.locale === locale) : undefined;
  if (!target) throw new ApiError(400, "validation_error", "This language is not enabled for the site");
  const siteId = post.siteId;
  // The source text comes from the same revision row as the id: an English edit committing in between cannot pair old
  // text with the new revision (which would make an outdated translation look current).
  const revision = await currentPostRevision(userId, postId);
  const revisionId = revision?.id ?? null;
  const snapshot = revision ? postRevisionSnapshot(revision.snapshot) : null;
  const english = snapshot ? { title: snapshot.title, summary: snapshot.summary, content: snapshot.content } : { title: post.title, summary: post.summary, content: post.content };

  const prior = await db.transaction(async (tx) => {
    const inserted = await tx.insert(postTranslations).values({ userId, siteId, postId, locale, status: "running", updatedAt: now }).onConflictDoNothing().returning({ id: postTranslations.id });
    if (inserted.length) return null;
    const [row] = await tx.select().from(postTranslations)
      .where(and(eq(postTranslations.postId, postId), eq(postTranslations.locale, locale), eq(postTranslations.userId, userId), eq(postTranslations.siteId, siteId))).for("update");
    if (!row) throw new ApiError(404, "not_found", "Post not found");
    if (row.status === "running" && now.getTime() - row.updatedAt.getTime() < RUNNING_STALE_MS) throw new ApiError(409, "conflict", "A translation is already running");
    await tx.update(postTranslations).set({ status: "running", updatedAt: now }).where(and(eq(postTranslations.id, row.id), eq(postTranslations.userId, userId), eq(postTranslations.siteId, siteId)));
    // The text of a dead run is still the best base there is, and it needs a person's eyes.
    return row.status === "running" ? { ...row, status: "needs_review" } : row;
  });
  return { userId, siteId, post, locale: target, prior, revisionId, english };
}

async function loadDeps(userId: string, siteId: string, postRow: typeof posts.$inferSelect, signal?: AbortSignal): Promise<LocalizeDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new ApiError(503, "service_unavailable", "Add an OpenRouter key in Integrations to translate with AI.");
  const guard = await checkAccountGuardrails(userId);
  if (guard.blocked) throw new ApiError(429, "rate_limited", guard.message);
  const settings = await getEffectiveSettings(userId, siteId);
  const resolved = resolveRunSettings("normal", parseEngineSettings(settings.engineSettings)).models;
  return {
    llm: await userEngineLlm(userId, endpoint),
    dataForSeo: createDataForSeoClient(process.env, dataForSeoSpend),
    models: { localize: await resolveEngineModel(endpoint, resolved.localize), review: await resolveEngineModel(endpoint, resolved.localize_review) },
    profile: (await resolveDestinationProvider(userId, siteId, postRow.preferredIntegrationId)) === "lindevo" ? "lindevo" : "markdown",
    origin: "web",
    logSpend: true,
    signal,
  };
}

/** What the post says in English now: its summary (or SEO description), content, cover alt text and primary query. */
async function sourceOf(claim: TranslationClaim) {
  const { userId, post, english } = claim;
  const seo = seoMetadata(post.seoMetadata);
  const [cover] = await db.select({ alt: imageAssets.altText }).from(imageAssets)
    .where(and(eq(imageAssets.userId, userId), eq(imageAssets.postId, post.id), eq(imageAssets.type, "cover")))
    .orderBy(desc(imageAssets.createdAt)).limit(1);
  return { title: english.title, description: english.summary || seo?.metaDescription || "", markdown: english.content, imageAlt: cover?.alt ?? "", keyword: seo?.primaryQuery ?? null };
}

/** What changed in the English since the translation's source revision, for update mode. */
async function changesSince(claim: TranslationClaim, content: string): Promise<string> {
  const id = claim.prior?.sourceRevisionId;
  if (!id) return "Unknown: compare the original with the existing translation and update whatever differs.";
  const [old] = await db.select().from(postRevisions).where(and(eq(postRevisions.id, id), eq(postRevisions.userId, claim.userId), eq(postRevisions.postId, claim.post.id))).limit(1);
  return old ? summarizeChange(postRevisionSnapshot(old.snapshot).content, content) : "Unknown: compare the original with the existing translation and update whatever differs.";
}

/**
 * Translates a claimed post and stores the result: update mode when a translation exists (its hand-edited wording is kept),
 * a new translation otherwise. The row becomes `ready` or `needs_review` and records the revision it was made from, so a later
 * edit of the English marks it stale. If the run throws, the row goes back to what it was (or is removed when there was none)
 * and the error is rethrown. `deps` is for tests.
 */
export async function runTranslation(claim: TranslationClaim, opts: { signal?: AbortSignal; deps?: LocalizeDeps; requests?: string } = {}): Promise<LocalizeResult> {
  const { userId, siteId, post, locale, prior } = claim;
  const where = and(eq(postTranslations.postId, post.id), eq(postTranslations.locale, locale.locale), eq(postTranslations.userId, userId), eq(postTranslations.siteId, siteId));
  try {
    const deps = opts.deps ?? await loadDeps(userId, siteId, post, opts.signal);
    const source = await sourceOf(claim);
    const hasBase = !!prior && prior.content.trim() !== "";
    if (opts.requests && !hasBase) throw new ApiError(400, "validation_error", "There is no translation to revise yet. Translate the post first.");
    const result = await localizeArticle({
      userId, siteId, locale, source, postId: post.id, deps,
      ...(hasBase ? {
        base: { title: prior.title, slug: prior.slug, description: prior.description, content: prior.content, imageAlt: prior.imageAlt, edited: prior.status === "edited" },
        changes: await changesSince(claim, source.markdown),
        ...(opts.requests ? { requests: opts.requests } : {}),
      } : {}),
    });
    const t = result.translation;
    await db.update(postTranslations).set({
      title: t.title, slug: t.slug, description: t.description, content: t.content, imageAlt: t.imageAlt, keyword: t.keyword,
      // What the engine wrote, so a later hand edit can be diffed against it (learning signals).
      engineContent: t.content,
      // A translation revised to the owner's corrections, or edited by hand before, is theirs: it stays edited, so every
      // later update keeps protecting its wording.
      status: (opts.requests || prior?.status === "edited") && result.status === "ready" ? "edited" : result.status, findings: result.findings, sourceRevisionId: claim.revisionId,
      costUsd: (prior?.costUsd ?? 0) + result.costUsd, updatedAt: new Date(),
    }).where(where);
    return result;
  } catch (error) {
    // The run is in the background, so the reason is kept on the row for the editor to show; the text of a previous
    // translation stays. A cancelled run (lease or request gone) is restored silently instead.
    if (opts.signal?.aborted) {
      if (prior && prior.content.trim() !== "") await db.update(postTranslations).set({ status: prior.status, updatedAt: prior.updatedAt }).where(where).catch(() => {});
      else await db.delete(postTranslations).where(where).catch(() => {});
    } else {
      const failure: Finding = { gate: "run", severity: "blocker", message: `The translation could not finish: ${failureReason(error)}` };
      const earlier = (prior?.findings as Finding[] | undefined)?.filter((f) => f.gate !== "run") ?? [];
      await db.update(postTranslations).set({ status: "needs_review", findings: [failure, ...earlier], updatedAt: new Date() }).where(where).catch(() => {});
    }
    throw error;
  }
}

/** A reason safe to show: our own API messages and the model clients' short status lines, never provider or prompt text. */
export function failureReason(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/^(LLM |Claude Code|Codex|claude-code|codex|Subscription|OpenRouter)/.test(message)) return message.slice(0, 200);
  return "the model call failed. Try again, or check the model settings.";
}

/** The on-demand "Translate" / "Update translation": `beginTranslation`, then `runTranslation`. */
export async function translatePost(userId: string, postId: string, locale: string, opts: { signal?: AbortSignal; deps?: LocalizeDeps } = {}): Promise<LocalizeResult> {
  return runTranslation(await beginTranslation(userId, postId, locale), opts);
}

export type { Finding };
