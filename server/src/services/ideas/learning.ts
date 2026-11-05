import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ideas, postPublications, posts, searchConsoleMetrics } from "../../db/schema.js";
import { seoMetadata } from "../seo-metadata.js";
import { updateSiteSettings } from "../user-settings.js";
import { SCORE_FACTORS, WEIGHT_HISTORY_LIMIT, getIdeaSettings, type ScoreWeights } from "./settings.js";

/** Rules follow Lindevo's learning/weights.ts: nudge each weight up to 10% toward what predicted search clicks. */
export const MIN_SAMPLES = 5;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 3;
const STEP = 0.1;
const DAY_MS = 86_400_000;
const WINDOW_START_DAYS = 30;
const WINDOW_END_DAYS = 58;
/** shortcut: one site is learned from at most this many ideas per run, newest publications first; raise if a site publishes more. */
const SAMPLE_LIMIT = 500;
const SITE_LIMIT = 200;

export type Sample = { factors: ScoreWeights; outcome: number };

/** Pearson correlation, or null when there are fewer than 2 points or either side has no variance. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * New weights from samples; the same object contents when there are too few samples. A factor with no variance keeps
 * its weight, and so does a factor the owner set to 0 (ignored): the 0.1 floor must not switch it back on.
 */
export function nextWeights(weights: ScoreWeights, samples: Sample[]): ScoreWeights {
  if (samples.length < MIN_SAMPLES) return { ...weights };
  const out = { ...weights };
  for (const f of SCORE_FACTORS) {
    if (weights[f] === 0) continue;
    const corr = pearson(samples.map((s) => s.factors[f]), samples.map((s) => s.outcome));
    if (corr === null) continue;
    out[f] = round4(clamp(weights[f] * (1 + STEP * clamp(corr, -1, 1)), MIN_WEIGHT, MAX_WEIGHT));
  }
  return out;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Lower case, no trailing slash; only plain slugs are matched. */
const cleanSlug = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\/+$/, "") : "";
  return /^[a-z0-9][a-z0-9-]*$/.test(s) ? s : null;
};

/**
 * Ideas whose post was published at least 58 days ago (the 28-day window after the first 30 days is complete),
 * with ln(1 + Search Console clicks) in that window as the outcome.
 * shortcut: the page path must end with /<slug>; a CMS that prefixes or rewrites the slug differently is not matched.
 */
export async function collectSamples(userId: string, siteId: string, now: Date): Promise<Sample[]> {
  const cutoff = new Date(now.getTime() - WINDOW_END_DAYS * DAY_MS);
  const rows = await db.select({
    id: ideas.id, breakdown: ideas.scoreBreakdown, seo: posts.seoMetadata, publishedAt: sql<Date>`min(coalesce(${postPublications.publishedAt}, ${postPublications.createdAt}))`,
  }).from(ideas)
    .innerJoin(posts, and(eq(posts.id, ideas.postId), eq(posts.userId, userId)))
    .innerJoin(postPublications, and(eq(postPublications.postId, posts.id), eq(postPublications.userId, userId), eq(postPublications.status, "published")))
    .where(and(eq(ideas.userId, userId), eq(ideas.siteId, siteId)))
    .groupBy(ideas.id, posts.id)
    .having(sql`min(coalesce(${postPublications.publishedAt}, ${postPublications.createdAt})) <= ${cutoff.toISOString()}::timestamptz`)
    .orderBy(sql`min(coalesce(${postPublications.publishedAt}, ${postPublications.createdAt})) desc`)
    .limit(SAMPLE_LIMIT);

  const samples: Sample[] = [];
  for (const row of rows) {
    const slug = cleanSlug(seoMetadata(row.seo)?.slug);
    const b = row.breakdown as Record<string, unknown> | null;
    const factors = {} as ScoreWeights;
    for (const f of SCORE_FACTORS) {
      const v = b?.[f];
      if (typeof v !== "number" || !Number.isFinite(v)) { factors[f] = NaN; break; }
      factors[f] = v;
    }
    if (!slug || SCORE_FACTORS.some((f) => Number.isNaN(factors[f]))) continue;
    const published = new Date(row.publishedAt);
    const from = new Date(published.getTime() + WINDOW_START_DAYS * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(published.getTime() + WINDOW_END_DAYS * DAY_MS).toISOString().slice(0, 10);
    const [sum] = await db.select({ clicks: sql<number>`coalesce(sum(${searchConsoleMetrics.clicks}), 0)::int` }).from(searchConsoleMetrics)
      .where(and(
        eq(searchConsoleMetrics.userId, userId), eq(searchConsoleMetrics.siteId, siteId),
        sql`${searchConsoleMetrics.date} >= ${from} and ${searchConsoleMetrics.date} < ${to}`,
        sql`lower(rtrim(${searchConsoleMetrics.pageUrl}, '/')) like ${"%/" + slug}`,
      ));
    samples.push({ factors, outcome: Math.log(1 + Number(sum?.clicks ?? 0)) });
  }
  return samples;
}

export type LearnResult = { status: "learned" | "off" | "already_learned" | "too_few_samples"; samples: number };

/** Moves the site's weights at most once per UTC month. Too few samples leaves the month open for a later retry. */
export async function learnSiteWeights(userId: string, siteId: string, now = new Date()): Promise<LearnResult> {
  const settings = await getIdeaSettings(userId, siteId);
  const month = monthOf(now);
  if (!settings.learnWeights) return { status: "off", samples: 0 };
  if (settings.weightsLearnedMonth === month) return { status: "already_learned", samples: 0 };
  const samples = await collectSamples(userId, siteId, now);
  if (samples.length < MIN_SAMPLES) return { status: "too_few_samples", samples: samples.length };
  const weights = nextWeights(settings.weights, samples);
  const ideaSettings = {
    ...settings, weights, weightsLearnedMonth: month,
    weightHistory: [...settings.weightHistory, { month, weights, samples: samples.length }].slice(-WEIGHT_HISTORY_LIMIT),
  };
  await updateSiteSettings(userId, siteId, { ideaSettings });
  return { status: "learned", samples: samples.length };
}

/** Every site with ideas, bounded; one site failing never stops the rest. */
export async function drainWeightLearning(now = new Date()) {
  const siteRows = await db.selectDistinct({ userId: ideas.userId, siteId: ideas.siteId }).from(ideas)
    .where(isNotNull(ideas.postId)).limit(SITE_LIMIT);
  let learned = 0, failed = 0;
  for (const { userId, siteId } of siteRows) {
    try {
      if ((await learnSiteWeights(userId, siteId, now)).status === "learned") learned += 1;
    } catch {
      failed += 1;
      console.error("[ideas] Weight learning failed for a site");
    }
  }
  return { sites: siteRows.length, learned, failed };
}
