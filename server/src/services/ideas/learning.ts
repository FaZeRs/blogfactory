import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
 * with ln(1 + Search Console clicks) in that window as the outcome. A post counts as published at the earlier of its
 * first "published" publication and, for a CMS that publishes a delivered draft itself (Lindevo), posts.publish_at once
 * a draft delivery succeeded and that time has passed.
 * shortcut: the page path must end with /<slug>; a CMS that prefixes or rewrites the slug differently is not matched.
 */
export async function collectSamples(userId: string, siteId: string, now: Date): Promise<Sample[]> {
  const cutoff = new Date(now.getTime() - WINDOW_END_DAYS * DAY_MS);
  const nowIso = now.toISOString();
  const viaPublication = sql`min(coalesce(${postPublications.publishedAt}, ${postPublications.createdAt})) filter (where ${postPublications.status} = 'published')`;
  const viaSchedule = sql`case when bool_or(${postPublications.status} = 'draft' and ${postPublications.publishMode} = 'draft') and ${posts.publishAt} <= ${nowIso}::timestamptz then ${posts.publishAt} end`;
  const publishedExpr = sql`least(${viaPublication}, ${viaSchedule})`;
  const rows = await db.select({
    id: ideas.id, breakdown: ideas.scoreBreakdown, seo: posts.seoMetadata, publishedAt: sql<Date>`${publishedExpr}`,
  }).from(ideas)
    .innerJoin(posts, and(eq(posts.id, ideas.postId), eq(posts.userId, userId)))
    .innerJoin(postPublications, and(eq(postPublications.postId, posts.id), eq(postPublications.userId, userId), inArray(postPublications.status, ["published", "draft"])))
    .where(and(eq(ideas.userId, userId), eq(ideas.siteId, siteId)))
    .groupBy(ideas.id, posts.id)
    .having(sql`${publishedExpr} <= ${cutoff.toISOString()}::timestamptz`)
    .orderBy(sql`${publishedExpr} desc`)
    .limit(SAMPLE_LIMIT);

  const ready: { id: string; factors: ScoreWeights; slug: string; from: string; to: string }[] = [];
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
    ready.push({
      id: row.id, factors, slug,
      from: new Date(published.getTime() + WINDOW_START_DAYS * DAY_MS).toISOString().slice(0, 10),
      to: new Date(published.getTime() + WINDOW_END_DAYS * DAY_MS).toISOString().slice(0, 10),
    });
  }
  if (!ready.length) return [];

  // One query for the whole site: each idea's window and slug joined to the site's metrics. Slugs are [a-z0-9-], so LIKE needs no escaping.
  const values = sql.join(ready.map((r) => sql`(${r.id}::uuid, ${r.slug}::text, ${r.from}::text, ${r.to}::text)`), sql`, `);
  const sums = await db.execute(sql`
    select v.id, coalesce(sum(m.clicks), 0)::int as clicks
    from (values ${values}) as v(id, slug, win_from, win_to)
    left join ${searchConsoleMetrics} m
      on m.user_id = ${userId} and m.site_id = ${siteId}
      and m.date >= v.win_from and m.date < v.win_to
      and lower(rtrim(m.page_url, '/')) like '%/' || v.slug
    group by v.id`);
  const clicksOf = new Map((sums as unknown as { id: string; clicks: number }[]).map((r) => [r.id, Number(r.clicks)]));
  return ready.map((r) => ({ factors: r.factors, outcome: Math.log(1 + (clicksOf.get(r.id) ?? 0)) }));
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
