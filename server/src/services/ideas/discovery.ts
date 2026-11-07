import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { feeds, generationLogs, ideaDiscoveries, ideas, posts } from "../../db/schema.js";
import { createDataForSeoClient } from "../../engine/adapters/dataforseo.js";
import { engineAiEndpoint, type EngineLlm } from "../../engine/adapters/llm.js";
import { createSearchClient } from "../../engine/adapters/search.js";
import type { DataForSeoClient, KeywordOverview } from "../../engine/adapters/types.js";
import { parseEngineSettings, resolveRunSettings } from "../../engine/modes.js";
import { dataForSeoSpend } from "../../engine/runtime/deps.js";
import { RateLimitError } from "../../engine/types.js";
import { truncate } from "../../engine/util.js";
import { getOpenRouterKey } from "../api-keys.js";
import { checkAccountGuardrails } from "../account-guardrails.js";
import { fetchRssArticles } from "../generation-sources.js";
import { finishOperationEvent, startOperationEvent } from "../operation-events.js";
import { safeFetch } from "../safe-fetch.js";
import { getEffectiveSettings, getSiteForUser } from "../user-settings.js";
import { generateCandidates, type Candidate, type SiteContext } from "./candidates.js";
import { visibilitySummary } from "../ai-visibility/summary.js";
import { assessNovelty, similarity, IDEA_REPEAT_SIMILARITY, REJECT_SIMILARITY } from "./novelty.js";
import { runAutopilot } from "./schedule.js";
import { combineScore, demandFactor, feasibilityFactor, trendFactor, type Factors } from "./score.js";
import { effectiveSeedTopics, getIdeaSettings, saveSeenLinks, type IdeaSettings } from "./settings.js";
import { collectSignals, signalAgeDays, type CollectorDeps, type Signal } from "./signals.js";
import { billedModel, resolveEngineModel, userEngineLlm } from "../engine-llm.js";

export type DiscoveryDeps = {
  llm: EngineLlm;
  /** Model id for the candidate call (the normal-mode brief model). */
  model: string;
  collectors: Omit<CollectorDeps, "seeds" | "competitors" | "locale" | "gscQueries" | "feedUrls" | "aiGaps" | "sources" | "recordSeen">;
  /** Adds its spend to the discovery's cost; the engine's monthly DataForSEO cap is shared. */
  dataForSeo: DataForSeoClient | null;
  dataForSeoSpent: () => number;
};

const MAX_KEYWORD_LOOKUPS = 20;
const CACHE_LIMIT = 2000;
const keywordCache = new Map<string, KeywordOverview | null>();

const localeOf = (language: string | null | undefined) => (/^[a-z]{2}/i.exec(language ?? "")?.[0] ?? "en").toLowerCase();

// ── queue ──

/** One active discovery per site (a partial unique index backs this): returns the running or queued one when it exists. */
export async function queueDiscovery(userId: string, siteId: string): Promise<{ id: string; created: boolean }> {
  if (!(await getSiteForUser(userId, siteId))) throw new Error("Site not found");
  const [created] = await db.insert(ideaDiscoveries).values({ userId, siteId }).onConflictDoNothing().returning({ id: ideaDiscoveries.id });
  if (created) return { id: created.id, created: true };
  const [active] = await db.select({ id: ideaDiscoveries.id }).from(ideaDiscoveries)
    .where(and(eq(ideaDiscoveries.userId, userId), eq(ideaDiscoveries.siteId, siteId), inArray(ideaDiscoveries.status, ["queued", "running"])))
    .limit(1);
  if (!active) throw new Error("Could not queue the discovery");
  return { id: active.id, created: false };
}

const STALE_RUNNING_MS = 15 * 60_000;

/** One statement: SKIP LOCKED makes concurrent workers take disjoint rows; a run that died is retaken after 15 minutes. */
async function claimDiscoveries(limit: number, now: Date, id?: string) {
  if (limit < 1) return [];
  const stale = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  return db.update(ideaDiscoveries)
    .set({ status: "running", startedAt: now, error: null })
    .where(sql`${ideaDiscoveries.id} IN (
      SELECT id FROM idea_discoveries
      WHERE (status = 'queued' OR (status = 'running' AND started_at < ${stale}::timestamptz))
        ${id ? sql`AND id = ${id}::uuid` : sql``}
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})`)
    .returning();
}

// ── pure scoring ──

export type ScoredIdea = {
  candidate: Candidate;
  factors: Factors;
  score: number;
  keyword: { volume: number | null; difficulty: number | null; intent: string | null } | null;
  nearest: { id: string; title: string; similarity: number } | null;
  origin: "discovered" | "refresh";
  sources: { url: string; title: string }[];
};

/** Factors, score and the duplicate decision for each candidate. Duplicates of a post are dropped; refresh candidates are kept. */
export function scoreCandidates(input: {
  candidates: Candidate[];
  signals: Signal[];
  metrics: Map<string, KeywordOverview | null>;
  existingPosts: { id: string; title: string }[];
  existingIdeaTitles: string[];
  /** Main keywords of existing ideas; a candidate targeting the same keyword is a repeat. */
  existingIdeaKeywords?: string[];
  weights: IdeaSettings["weights"];
  now: Date;
}): ScoredIdea[] {
  const byId = new Map(input.signals.map((s) => [s.id, s]));
  const accepted: string[] = [...input.existingIdeaTitles];
  const acceptedKeywords: string[] = [...(input.existingIdeaKeywords ?? [])];
  const out: ScoredIdea[] = [];
  for (const c of input.candidates) {
    // Ideas compete for the same slots, so near-repeats are dropped earlier than near-repeats of posts.
    if (accepted.some((t) => similarity(c.title, t) >= IDEA_REPEAT_SIMILARITY)) continue;
    if (acceptedKeywords.some((k) => similarity(c.primaryKeyword, k) >= REJECT_SIMILARITY)) continue;
    const nov = assessNovelty({ title: c.title, keyword: c.primaryKeyword }, input.existingPosts);
    if (nov.decision === "reject") continue;
    const used = c.signalIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const trend = trendFactor({
      signalCount: used.length,
      distinctSources: new Set(used.map((s) => s.source)).size,
      avgAgeDays: used.length ? used.reduce((n, s) => n + signalAgeDays(s, input.now), 0) / used.length : 7,
    });
    const kw = input.metrics.get(c.primaryKeyword.toLowerCase()) ?? null;
    const factors: Factors = {
      trend,
      fit: c.fit / 10,
      demand: demandFactor({ volume: kw?.volume ?? null, estimate: c.demandEstimate, trend }),
      feasibility: feasibilityFactor(kw?.difficulty),
      novelty: nov.novelty,
      gain: c.gain / 10,
    };
    accepted.push(c.title);
    acceptedKeywords.push(c.primaryKeyword);
    out.push({
      candidate: c,
      factors,
      score: combineScore(factors, input.weights),
      keyword: kw ? { volume: kw.volume, difficulty: kw.difficulty, intent: kw.intent } : null,
      nearest: nov.decision === "refresh" ? nov.nearest : null,
      origin: nov.decision === "refresh" ? "refresh" : "discovered",
      sources: used.flatMap((s) => (s.url ? [{ url: s.url, title: truncate(s.title, 200) }] : [])).slice(0, 5),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Volume, difficulty and intent per primary keyword. The keyword signals already carry data, so only the rest is looked up, once per process. */
export async function fetchKeywordMetrics(input: {
  dataForSeo: DataForSeoClient | null;
  locale: string;
  keywords: string[];
  signals: Signal[];
  signal?: AbortSignal;
}): Promise<Map<string, KeywordOverview | null>> {
  const out = new Map<string, KeywordOverview | null>();
  for (const s of input.signals) {
    if (s.source === "keywords" && s.metric) {
      out.set(s.title.toLowerCase(), { keyword: s.title, volume: Number(s.metric.volume) || null, difficulty: s.metric.difficulty == null ? null : Number(s.metric.difficulty), intent: (s.metric.intent as string | null) ?? null, aiOverview: false });
    }
  }
  if (!input.dataForSeo) return out;
  let lookups = 0;
  for (const kw of new Set(input.keywords.map((k) => k.toLowerCase()))) {
    if (out.has(kw)) continue;
    const key = `${input.locale}|${kw}`;
    if (keywordCache.has(key)) { out.set(kw, keywordCache.get(key)!); continue; }
    if (lookups >= MAX_KEYWORD_LOOKUPS) break;
    lookups += 1;
    try {
      const data = await input.dataForSeo.keywordOverview(kw, { locale: input.locale, signal: input.signal });
      if (keywordCache.size >= CACHE_LIMIT) keywordCache.clear();
      keywordCache.set(key, data);
      out.set(kw, data);
    } catch (error) {
      if (input.signal?.aborted || error instanceof RateLimitError) break;
    }
  }
  return out;
}

// ── run ──

export async function loadDiscoveryDeps(userId: string, engineSettings: unknown): Promise<DiscoveryDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new Error("OpenRouter is not configured");
  let spent = 0;
  const dataForSeo = createDataForSeoClient(process.env, {
    monthlySpentUsd: dataForSeoSpend.monthlySpentUsd,
    recordSpend: async (usd) => { spent += usd; await dataForSeoSpend.recordSpend(usd); },
  });
  let model = resolveRunSettings("normal", parseEngineSettings(engineSettings)).models.brief;
  model = await resolveEngineModel(endpoint, model);
  return {
    llm: await userEngineLlm(userId, endpoint),
    model,
    dataForSeo,
    dataForSeoSpent: () => spent,
    collectors: {
      now: () => new Date(),
      search: createSearchClient(process.env, dataForSeo),
      dataForSeo,
      fetchText: async (url, signal) => {
        const res = await safeFetch(url, { signal, timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      },
      fetchJson: async (url, signal) => {
        const res = await safeFetch(url, { signal, timeoutMs: 10_000, maxResponseBytes: 1024 * 1024, headers: { Accept: "application/json", "User-Agent": "BlogFactory idea sources (+https://blogfactory.io)" } });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      fetchFeed: async (url, limit, days) => (await fetchRssArticles(url, limit, days)).map((a) => ({ title: a.title, url: a.url, pubDate: a.pubDate })),
    },
  };
}

async function readGscQueries(userId: string, siteId: string, now: Date) {
  const since = new Date(now.getTime() - 28 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT query, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks,
           (SUM(position * impressions) / NULLIF(SUM(impressions), 0))::float8 AS position
    FROM search_console_metrics
    WHERE user_id = ${userId}::uuid AND site_id = ${siteId}::uuid AND date >= ${since}
    GROUP BY query
    HAVING SUM(impressions) >= 20 AND SUM(position * impressions) / NULLIF(SUM(impressions), 0) BETWEEN 8 AND 30
    ORDER BY SUM(impressions) DESC LIMIT 40`);
  return (rows as unknown as { query: string; impressions: number; clicks: number; position: number }[]).map((r) => ({
    query: r.query, impressions: Number(r.impressions), clicks: Number(r.clicks), position: Number(r.position),
  }));
}

async function readFeedUrls(userId: string, siteId: string) {
  const rows = await db.select({ url: feeds.sourceUrl }).from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.siteId, siteId), eq(feeds.platform, "rss"), eq(feeds.isActive, true)));
  return rows.flatMap((r) => (r.url ? [r.url] : []));
}

/** Existing posts of the site plus the titles in its internal-link index (its sitemap pages). */
export async function readExistingContent(userId: string, siteId: string, index: unknown) {
  const rows = await db.select({ id: posts.id, title: posts.title }).from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.siteId, siteId))).orderBy(desc(posts.createdAt)).limit(1000);
  const pages = Array.isArray((index as { pages?: unknown })?.pages) ? (index as { pages: { url?: unknown; title?: unknown }[] }).pages : [];
  const indexed = pages.flatMap((p) => (typeof p.title === "string" && p.title && typeof p.url === "string" ? [{ id: p.url, title: p.title }] : [])).slice(0, 2000);
  return [...rows, ...indexed];
}

export type DiscoveryResult = { signalCount: number; ideaCount: number; costUsd: number };

async function execute(row: typeof ideaDiscoveries.$inferSelect, injected?: DiscoveryDeps): Promise<DiscoveryResult> {
  const { userId, siteId } = row;
  const started = Date.now();
  const eventId = await startOperationEvent({ userId, siteId, origin: "system", action: "ideas.discovery", objectType: "idea_discovery", objectId: row.id });
  let llmCost = 0;
  let model: string | null = null;
  let deps: DiscoveryDeps | undefined = injected;
  const result: DiscoveryResult = { signalCount: 0, ideaCount: 0, costUsd: 0 };
  let sources = "";
  let failedCollectors = 0;
  try {
    const site = await getSiteForUser(userId, siteId);
    if (!site) throw new Error("Site not found");
    const guard = await checkAccountGuardrails(userId);
    if (guard.blocked) throw new Error(guard.message);
    const [settings, effective] = await Promise.all([getIdeaSettings(userId, siteId), getEffectiveSettings(userId, siteId)]);
    deps ??= await loadDiscoveryDeps(userId, effective.engineSettings);
    model = deps.model;
    const locale = localeOf(site.language);
    const seeds = effectiveSeedTopics(settings, site);
    const now = deps.collectors.now();

    const seen: Record<string, string[]> = {};
    const { signals, reports } = await collectSignals({
      ...deps.collectors,
      locale, seeds, competitors: settings.competitors,
      sources: settings.sources,
      recordSeen: (url, links) => { seen[url] = links; },
      gscQueries: () => readGscQueries(userId, siteId, now),
      feedUrls: () => readFeedUrls(userId, siteId),
      aiGaps: async () => {
        const s = await visibilitySummary(userId, siteId);
        return s.trend.length < 2 ? s.gaps : s.gaps.filter((g) => g.twoWeeks);
      },
    });
    sources = reports.filter((r) => r.count > 0).map((r) => r.source).join(",");
    failedCollectors = reports.filter((r) => r.error).length;
    result.signalCount = signals.length;

    if (signals.length) {
      const existingPosts = await readExistingContent(userId, siteId, site.internalLinkIndex);
      const context: SiteContext = {
        name: site.name, domain: site.domain, language: site.language, topics: seeds,
        description: effective.brandDescription, audience: effective.brandTargetAudience,
      };
      // Every idea the site already has, rejected ones included: the model skips them even when reworded.
      const existingIdeas = await db.select({ title: ideas.title, keyword: ideas.primaryKeyword, status: ideas.status }).from(ideas)
        .where(and(eq(ideas.userId, userId), eq(ideas.siteId, siteId), ne(ideas.status, "archived")))
        .orderBy(desc(ideas.createdAt)).limit(300);
      const gen = await generateCandidates({
        llm: deps.llm, model: deps.model, site: context, postTitles: existingPosts.map((p) => p.title), signals,
        ideaTitles: existingIdeas.map((i) => `${i.title}${i.status === "rejected" ? " (rejected)" : ""}`),
      });
      llmCost = gen.costUsd;
      model = gen.model;
      const metrics = await fetchKeywordMetrics({ dataForSeo: deps.dataForSeo, locale, keywords: gen.candidates.map((c) => c.primaryKeyword), signals });
      const scored = scoreCandidates({
        candidates: gen.candidates, signals, metrics, existingPosts,
        existingIdeaTitles: existingIdeas.map((i) => i.title),
        existingIdeaKeywords: existingIdeas.flatMap((i) => (i.keyword ? [i.keyword] : [])),
        weights: settings.weights, now,
      });
      if (scored.length) {
        await db.insert(ideas).values(scored.map((s) => ({
          userId, siteId, status: "new", origin: s.origin, discoveryId: row.id, mode: settings.defaultMode,
          title: s.candidate.title,
          angle: s.candidate.angle || null,
          primaryKeyword: s.candidate.primaryKeyword,
          alternateKeywords: s.candidate.alternateKeywords,
          searchIntent: s.candidate.searchIntent || s.keyword?.intent || null,
          audienceQuestion: s.candidate.audienceQuestion || null,
          brief: {
            whyNow: s.candidate.whyNow,
            outline: s.candidate.outline,
            informationGain: s.candidate.informationGain,
            sources: s.sources,
            suggestedMode: s.score >= 75 && s.factors.gain >= 0.7 ? "deep" : "normal",
          },
          score: s.score,
          scoreBreakdown: { ...s.factors, keyword: s.keyword, nearestPost: s.nearest, rationale: s.candidate.rationale },
        })));
      }
      result.ideaCount = scored.length;
    }
    // The baseline moves only once the ideas are saved, so a failed run does not swallow new links. Late recordings from timed-out collectors are not saved.
    if (Object.keys(seen).length) await saveSeenLinks(userId, siteId, { ...seen }).catch(() => console.error("[ideas] Could not save the watched pages' links"));
    // A failed autopilot step must not fail a discovery whose ideas are saved; the ideas stay in the inbox.
    await runAutopilot(userId, siteId, settings).catch(() => console.error("[ideas] Autopilot step failed"));
    result.costUsd = llmCost + (deps.dataForSeoSpent?.() ?? 0);
    await db.update(ideaDiscoveries).set({ status: "done", signalCount: result.signalCount, ideaCount: result.ideaCount, costUsd: result.costUsd, finishedAt: new Date() })
      .where(and(eq(ideaDiscoveries.id, row.id), eq(ideaDiscoveries.userId, userId)));
    await finishOperationEvent({ id: eventId, status: "succeeded", durationMs: Date.now() - started, siteId, metadata: {
      signal_count: result.signalCount, idea_count: result.ideaCount, cost_usd: Math.round(result.costUsd * 10_000) / 10_000, sources, failed_collectors: failedCollectors,
    } });
    return result;
  } catch (error) {
    // A reply that was paid for before the failure is still booked.
    llmCost += Number((error as { costUsd?: number })?.costUsd) || 0;
    const costUsd = llmCost + (deps?.dataForSeoSpent?.() ?? 0);
    const message = truncate(error instanceof Error ? error.message : "Discovery failed", 300);
    await db.update(ideaDiscoveries).set({ status: "failed", error: message, costUsd, signalCount: result.signalCount, finishedAt: new Date() })
      .where(and(eq(ideaDiscoveries.id, row.id), eq(ideaDiscoveries.userId, userId)));
    await finishOperationEvent({ id: eventId, status: "failed", durationMs: Date.now() - started, siteId, errorCode: "discovery_failed", metadata: {
      signal_count: result.signalCount, cost_usd: Math.round(costUsd * 10_000) / 10_000, sources, failed_collectors: failedCollectors,
    } }).catch(() => undefined);
    throw error;
  } finally {
    await logIdeaSpend({ userId, model, costUsd: llmCost + (deps?.dataForSeoSpent?.() ?? 0), ok: result.ideaCount > 0 || result.signalCount > 0, discoveryId: row.id });
  }
}

/** Logged so the account's monthly and daily guardrails count idea spend: a discovery's, or a manual idea's rating call. */
export async function logIdeaSpend(input: { userId: string; model: string | null; costUsd: number; ok: boolean; discoveryId?: string }) {
  if (!(input.costUsd > 0)) return;
  const model = input.model && billedModel(input.model);
  await db.insert(generationLogs).values({
    userId: input.userId, usageType: "text", modelId: model, provider: model?.split("/")[0] ?? null,
    status: input.ok ? "success" : "failed", cost: input.costUsd, sessionId: input.discoveryId ?? null,
    responseData: { ideas: input.discoveryId ? { discoveryId: input.discoveryId } : { manual: true } },
  }).catch(() => console.error("[ideas] Could not log idea spend"));
}

/** Runs one discovery by id (queued, or stale and running). Resolves to null when another worker holds it. */
export async function runDiscovery(discoveryId: string, deps?: DiscoveryDeps): Promise<DiscoveryResult | null> {
  const [row] = await claimDiscoveries(1, new Date(), discoveryId);
  return row ? execute(row, deps) : null;
}

/**
 * Runs up to `limit` discoveries one after another, claiming each just before it runs: a row claimed early would age
 * past the stale window while it waits and another worker would retake it. Failures are recorded on the row and never thrown.
 */
export async function drainIdeaDiscoveries(limit: number, deps?: DiscoveryDeps): Promise<{ processed: number; failed: number }> {
  let processed = 0, failed = 0;
  for (; processed < limit; processed += 1) {
    const [row] = await claimDiscoveries(1, new Date());
    if (!row) break;
    await execute(row, deps).catch(() => { failed += 1; });
  }
  return { processed, failed };
}
