import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleRuns, ideas, postPublications, posts, searchConsoleIntegrations, searchConsoleMetrics } from "../../db/schema.js";
import { truncate } from "../../engine/util.js";
import { getIdeaSettings } from "../ideas/settings.js";
import { logIdeaEvent } from "../ideas/schedule.js";
import { seoMetadata } from "../seo-metadata.js";

/** Lindevo's thresholds (`learning/refresh-rule.ts`), on BlogFactory's stored Search Console metrics. */
export const MIN_AGE_DAYS = 90;
export const CLICK_DROP = 0.3;
export const MIN_PREVIOUS_CLICKS = 10;
export const POSITION_WORSE_BY = 5;
export const STRIKING_MIN_POSITION = 8;
export const STRIKING_MAX_POSITION = 20;
export const STRIKING_MIN_IMPRESSIONS = 100;
export const COOLDOWN_DAYS = 28;
export const MAX_NEW_PER_DAY = 2;
/** Search Console data lags; each 28-day window ends this many days ago. */
export const DATA_LAG_DAYS = 3;
const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;
const SITE_LIMIT = 200;

export const REFRESH_ANGLE = "Keep what still holds, update what changed, and answer the searches the post already appears for.";

export type Window = { clicks: number; impressions: number; position: number };
export type RefreshVerdict = { kind: "declining" | "striking"; reason: string; severity: number };

const pct = (n: number) => Math.round(n * 100);

/** Pure rule: whether a post that is old enough needs a refresh, and why. Declining wins over striking distance. */
export function classifyRefresh(input: { ageDays: number; current: Window; previous: Window }): RefreshVerdict | null {
  const { ageDays, current, previous } = input;
  if (ageDays < MIN_AGE_DAYS) return null;
  const drop = previous.clicks > 0 ? (previous.clicks - current.clicks) / previous.clicks : 0;
  if (previous.clicks >= MIN_PREVIOUS_CLICKS && drop >= CLICK_DROP) {
    return { kind: "declining", reason: `clicks −${pct(drop)}% (28d)`, severity: 1000 + drop * 100 };
  }
  if (current.impressions > 0 && previous.impressions > 0 && current.position - previous.position >= POSITION_WORSE_BY) {
    return { kind: "declining", reason: `position ${previous.position.toFixed(1)} → ${current.position.toFixed(1)} (28d)`, severity: 1000 + (current.position - previous.position) };
  }
  if (current.impressions >= STRIKING_MIN_IMPRESSIONS && current.position >= STRIKING_MIN_POSITION && current.position <= STRIKING_MAX_POSITION) {
    return { kind: "striking", reason: `position ${current.position.toFixed(1)}, ${current.impressions} impressions (28d)`, severity: current.impressions };
  }
  return null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The two comparison windows: the 28 days ending 3 days ago, and the 28 days before them. */
export function windows(now: Date) {
  const end = new Date(now.getTime() - DATA_LAG_DAYS * DAY_MS);
  const curStart = new Date(end.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  const prevEnd = new Date(curStart.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  return { curStart: isoDay(curStart), curEnd: isoDay(end), prevStart: isoDay(prevStart), prevEnd: isoDay(prevEnd) };
}

/** A page URL as a comparison key: no scheme, www, query, fragment or trailing slash. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

const cleanSlug = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/^\/+|\/+$/g, "") : "";
  return /^[a-z0-9][a-z0-9-]*$/.test(s) ? s : null;
};

type PostPages = { id: string; title: string; firstPublishedAt: Date; keys: Set<string>; slug: string | null };

/** A Search Console page belongs to a post when it is a publication URL of the post or its path ends with the post's slug. */
const pageBelongs = (post: PostPages, pageUrl: string) => {
  const key = pageKey(pageUrl);
  return key !== null && (post.keys.has(key) || (post.slug !== null && key.endsWith(`/${post.slug}`)));
};

async function publishedPosts(userId: string, siteId: string): Promise<PostPages[]> {
  const first = sql<Date>`min(coalesce(${postPublications.publishedAt}, ${postPublications.createdAt}))`;
  const rows = await db.select({
    id: posts.id, title: posts.title, seo: posts.seoMetadata, first,
    urls: sql<(string | null)[]>`array_agg(${postPublications.externalUrl})`,
  }).from(posts)
    .innerJoin(postPublications, and(eq(postPublications.postId, posts.id), eq(postPublications.userId, userId), inArray(postPublications.status, ["published", "draft"])))
    .where(and(eq(posts.userId, userId), eq(posts.siteId, siteId)))
    .groupBy(posts.id);
  return rows.map((r) => ({
    id: r.id, title: r.title, firstPublishedAt: new Date(r.first), slug: cleanSlug(seoMetadata(r.seo)?.slug),
    keys: new Set(r.urls.flatMap((u) => { const k = u ? pageKey(u) : null; return k ? [k] : []; })),
  }));
}

const empty = (): Window => ({ clicks: 0, impressions: 0, position: 0 });
function addTo(w: Window, clicks: number, impressions: number, weightedPosition: number) {
  const total = w.position * w.impressions + weightedPosition;
  w.clicks += clicks;
  w.impressions += impressions;
  w.position = w.impressions > 0 ? total / w.impressions : 0;
}

/** Ideas that keep a post out of detection: still open, or touched within the cooldown. */
async function blockedPosts(userId: string, siteId: string, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS);
  const [fromIdeas, fromRuns] = await Promise.all([
    db.select({ id: ideas.refreshPostId }).from(ideas).where(and(
      eq(ideas.userId, userId), eq(ideas.siteId, siteId), sql`${ideas.refreshPostId} is not null`,
      sql`(${ideas.status} in ('new', 'approved', 'scheduled', 'in_progress') or ${ideas.updatedAt} >= ${since.toISOString()}::timestamptz)`,
    )),
    db.select({ id: sql<string>`${articleRuns.settings}->>'refreshPostId'` }).from(articleRuns).where(and(
      eq(articleRuns.userId, userId), eq(articleRuns.siteId, siteId), sql`${articleRuns.settings}->>'refreshPostId' is not null`,
      sql`${articleRuns.state} not in ('done', 'failed', 'escalated')`,
    )),
  ]);
  return new Set([...fromIdeas, ...fromRuns].flatMap((r) => (r.id ? [r.id] : [])));
}

export type RefreshCandidate = { post: PostPages; verdict: RefreshVerdict };

/** Posts of the site that need a refresh, best first. Does not apply the daily cap. */
export async function findRefreshCandidates(userId: string, siteId: string, now = new Date()): Promise<RefreshCandidate[]> {
  const w = windows(now);
  const byPage = (start: string, end: string) => db.select({
    pageUrl: searchConsoleMetrics.pageUrl,
    clicks: sql<number>`sum(${searchConsoleMetrics.clicks})::int`,
    impressions: sql<number>`sum(${searchConsoleMetrics.impressions})::int`,
    weighted: sql<number>`coalesce(sum(${searchConsoleMetrics.position} * ${searchConsoleMetrics.impressions}), 0)::float`,
  }).from(searchConsoleMetrics).where(and(
    eq(searchConsoleMetrics.userId, userId), eq(searchConsoleMetrics.siteId, siteId),
    gte(searchConsoleMetrics.date, start), lte(searchConsoleMetrics.date, end),
  )).groupBy(searchConsoleMetrics.pageUrl);
  const [candidates, blocked, currentPages, previousPages] = await Promise.all([
    publishedPosts(userId, siteId), blockedPosts(userId, siteId, now), byPage(w.curStart, w.curEnd), byPage(w.prevStart, w.prevEnd),
  ]);
  const out: RefreshCandidate[] = [];
  for (const post of candidates) {
    if (blocked.has(post.id)) continue;
    const current = empty(), previous = empty();
    for (const p of currentPages) if (pageBelongs(post, p.pageUrl)) addTo(current, p.clicks, p.impressions, p.weighted);
    for (const p of previousPages) if (pageBelongs(post, p.pageUrl)) addTo(previous, p.clicks, p.impressions, p.weighted);
    const verdict = classifyRefresh({ ageDays: (now.getTime() - post.firstPublishedAt.getTime()) / DAY_MS, current, previous });
    if (verdict) out.push({ post, verdict });
  }
  return out.sort((a, b) => b.verdict.severity - a.verdict.severity);
}

/** The queries a post's pages appeared for in the last 28 days, by impressions. */
export async function topQueriesForPost(userId: string, siteId: string, postId: string, now = new Date(), limit = 10): Promise<string[]> {
  const post = (await publishedPosts(userId, siteId)).find((p) => p.id === postId);
  if (!post) return [];
  const since = isoDay(new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
  const rows = await db.select({
    pageUrl: searchConsoleMetrics.pageUrl, query: searchConsoleMetrics.query, impressions: sql<number>`sum(${searchConsoleMetrics.impressions})::int`,
  }).from(searchConsoleMetrics).where(and(
    eq(searchConsoleMetrics.userId, userId), eq(searchConsoleMetrics.siteId, siteId), gte(searchConsoleMetrics.date, since),
  )).groupBy(searchConsoleMetrics.pageUrl, searchConsoleMetrics.query);
  const byQuery = new Map<string, number>();
  for (const r of rows) if (r.query && pageBelongs(post, r.pageUrl)) byQuery.set(r.query, (byQuery.get(r.query) ?? 0) + r.impressions);
  return [...byQuery].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([q]) => q);
}

/** Creates up to the daily cap of refresh ideas for one site. Returns how many were created. */
export async function detectRefreshIdeas(userId: string, siteId: string, now = new Date()): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ideas).where(and(
    eq(ideas.userId, userId), eq(ideas.siteId, siteId), eq(ideas.origin, "refresh"), gte(ideas.createdAt, new Date(now.getTime() - DAY_MS)),
  ));
  const room = MAX_NEW_PER_DAY - (n ?? 0);
  if (room < 1) return 0;
  const found = (await findRefreshCandidates(userId, siteId, now)).slice(0, room);
  if (!found.length) return 0;
  const settings = await getIdeaSettings(userId, siteId);
  let created = 0;
  for (const { post, verdict } of found) {
    const queries = await topQueriesForPost(userId, siteId, post.id, now, 3);
    const [row] = await db.insert(ideas).values({
      userId, siteId, status: "new", origin: "refresh", mode: settings.defaultMode,
      title: truncate(`Refresh: ${post.title}`, 200), angle: REFRESH_ANGLE, primaryKeyword: queries[0] ?? null,
      refreshPostId: post.id, refreshReason: verdict.reason,
      // Unscored on purpose: autopilot only books ideas at or above its minimum score, and rewriting a live post stays the owner's call.
      brief: { whyNow: `${verdict.reason}. Update the post and answer what readers search for.`, outline: [], informationGain: [], sources: [], suggestedMode: "normal" },
    }).returning({ id: ideas.id });
    if (row) {
      created += 1;
      await logIdeaEvent({ userId, siteId, action: "ideas.refresh_detect", ideaId: row.id, origin: "system", status: "new" });
    }
  }
  return created;
}

/** Every site with a connected Search Console, bounded; one site failing never stops the rest. */
export async function drainRefreshDetection(now = new Date()) {
  const siteRows = await db.selectDistinct({ userId: searchConsoleIntegrations.userId, siteId: searchConsoleIntegrations.siteId })
    .from(searchConsoleIntegrations).where(eq(searchConsoleIntegrations.status, "connected")).limit(SITE_LIMIT);
  let created = 0, failed = 0;
  for (const { userId, siteId } of siteRows) {
    try {
      created += await detectRefreshIdeas(userId, siteId, now);
    } catch {
      failed += 1;
      console.error("[refresh] Detection failed for a site");
    }
  }
  return { sites: siteRows.length, created, failed };
}
