import { and, eq } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { articleEvidence, articleSources } from "../../../db/schema.js";
import type { ReadPage } from "../../adapters/reader.js";
import { ENGINE_CONFIG } from "../../config.js";
import { verifyQuote } from "../../evidence/verify.js";
import { MODE_PRESETS } from "../../modes.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage, StageContext, StageOutcome } from "../../runtime/stage.js";
import { RateLimitError, StageInputError, type EngineMode } from "../../types.js";
import { isBoilerplateTitle, mapLimit, sanitizeText, truncate } from "../../util.js";
import { modelFor } from "../shared.js";
import {
  ClaimExtractionSchema,
  ResearchQueriesSchema,
  type ExtractedClaim,
  type ResearchOutput,
} from "./schema.js";

export type ResearchInput = {
  topic: string;
  sourceType: string;
  locale: string;
  maxQueries: number;
  maxPages: number;
  maxClaimsPerPage: number;
  minVerifiedClaims: number;
};

export type ResearchSource = {
  url: string;
  finalUrl: string;
  title: string | null;
  markdown: string;
  status: number;
  fetchedVia: string;
  fetchedAt: Date;
};
export type ResearchRow = {
  sourceIndex: number;
  claim: string;
  quote: string;
  kind: string;
  verified: boolean;
  method: string | null;
  ratio: number | null;
  reason: string | null;
};
export type ResearchResult = { queries: string[]; sources: ResearchSource[]; rows: ResearchRow[]; skipped: number };

const FETCH_CONCURRENCY = 3;
const CLAIM_CONCURRENCY = 2;
const MIN_SOURCE_CHARS = 400;
const SOURCE_PROMPT_CHARS = 24_000;
const TRACKING_PARAM = /^(utm_|mc_)|^(fbclid|gclid)$/i;

/** http(s) only, no hash, credentials or tracking parameters, no trailing slash on a path. */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  const text = url.toString();
  return url.pathname.length > 1 && !url.search && text.endsWith("/") ? text.slice(0, -1) : text;
}

const usage = (r: { model: string; promptTokens: number; completionTokens: number; costUsd: number }) => ({
  model: r.model,
  promptTokens: r.promptTokens,
  completionTokens: r.completionTokens,
  costUsd: r.costUsd,
});
type Usage = ReturnType<typeof usage>;

/** Plans queries, searches, reads pages and extracts claims; verification is code, never the model. */
export async function researchCore(input: ResearchInput, ctx: StageContext, spent: Usage[] = []): Promise<ResearchResult> {
  const { llm, search, reader, now } = ctx.deps;
  const topic = fenceData("topic", input.topic);

  const qPrompt = await preparePrompt("research-queries", {
    dataRule: DATA_RULE,
    maxQueries: input.maxQueries,
    locale: input.locale,
    today: now().toISOString().slice(0, 10),
    topic,
  });
  const planned = await llm.json({
    role: "research_queries",
    model: modelFor(ctx.run, "research_queries"),
    system: qPrompt.system,
    user: qPrompt.user,
    schema: ResearchQueriesSchema,
    maxTokens: 800,
    signal: ctx.signal,
  });
  spent.push(usage(planned));
  const queries = planned.value.queries.slice(0, input.maxQueries);

  // URLs and the search hit's own title (a crawl's first heading is often a cookie banner).
  const urls: string[] = [];
  const titles = new Map<string, string>();
  for (const query of queries) {
    const hits = await search.search(query, { locale: input.locale, limit: 6, signal: ctx.signal });
    for (const hit of hits) {
      const url = normalizeUrl(hit.url);
      if (!url || urls.includes(url)) continue;
      urls.push(url);
      if (hit.title.trim() && !isBoilerplateTitle(hit.title)) titles.set(url, hit.title.trim());
    }
  }

  // `reader.read` throws on non-public URLs: a page that cannot be read is skipped, not a stage failure.
  const fetched = await mapLimit(urls.slice(0, input.maxPages), FETCH_CONCURRENCY, async (url) => {
    try {
      return { url, page: await reader.read(url, ctx.signal) as ReadPage };
    } catch {
      if (ctx.signal.aborted) throw new Error("research aborted");
      return { url, page: null };
    }
  });
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const { url, page } of fetched) {
    if (!page || page.status !== 200 || page.markdown.length < MIN_SOURCE_CHARS) continue;
    const finalUrl = normalizeUrl(page.finalUrl) ?? url;
    if (seen.has(finalUrl)) continue;
    seen.add(finalUrl);
    sources.push({
      url: page.url,
      finalUrl,
      title: titles.get(url) ?? page.title,
      markdown: sanitizeText(page.markdown),
      status: page.status,
      fetchedVia: page.fetchedVia,
      fetchedAt: page.fetchedAt,
    });
  }

  const results = await mapLimit(sources, CLAIM_CONCURRENCY, async (source, sourceIndex) => {
    const prompt = await preparePrompt("research-claims", {
      dataRule: DATA_RULE,
      maxClaims: input.maxClaimsPerPage,
      topic,
      page: fenceData("page", [`URL: ${source.finalUrl}`, `Title: ${source.title ?? ""}`, "", truncate(source.markdown, SOURCE_PROMPT_CHARS)].join("\n")),
    });
    try {
      const r = await llm.json({
        role: "research_claims",
        model: modelFor(ctx.run, "research_claims"),
        system: prompt.system,
        user: prompt.user,
        schema: ClaimExtractionSchema,
        maxTokens: 2500,
        signal: ctx.signal,
      });
      spent.push(usage(r));
      return { sourceIndex, claims: r.value.claims.slice(0, input.maxClaimsPerPage) as ExtractedClaim[] };
    } catch (error) {
      // A rate limit reschedules the whole stage; an abort stops it. Anything else belongs to this page alone.
      if (error instanceof RateLimitError || ctx.signal.aborted) throw error;
      return { sourceIndex, claims: null, error };
    }
  });
  const failed = results.filter((r) => r.claims === null);
  if (failed.length && failed.length === results.length) throw (failed.at(-1) as { error: unknown }).error;

  const rows: ResearchRow[] = results.flatMap(({ sourceIndex, claims }) =>
    (claims ?? []).map((c) => {
      const claim = sanitizeText(c.claim);
      const quote = sanitizeText(c.quote);
      const source = sources[sourceIndex]!;
      const v = verifyQuote({
        claim,
        quote,
        page: { markdown: source.markdown, status: source.status, fetchedAt: source.fetchedAt },
        now: now(),
        config: ENGINE_CONFIG.evidence,
      });
      return {
        sourceIndex,
        claim,
        quote,
        kind: c.kind,
        verified: v.verified,
        method: v.verified ? (v.score === 1 ? "exact" : "fuzzy") : null,
        ratio: v.score,
        reason: v.reason,
      };
    }),
  );
  return { queries, sources, rows, skipped: failed.length };
}

/** Replaces this run's sources and evidence (a retry starts clean); every query is user- and run-scoped. */
async function persist(ctx: StageContext, result: ResearchResult) {
  const { run } = ctx;
  return db.transaction(async (tx) => {
    const scope = (t: typeof articleEvidence | typeof articleSources) => and(eq(t.runId, run.id), eq(t.userId, run.userId));
    await tx.delete(articleEvidence).where(scope(articleEvidence));
    await tx.delete(articleSources).where(scope(articleSources));
    const stored = result.sources.length
      ? await tx.insert(articleSources).values(result.sources.map((s) => ({
          runId: run.id,
          userId: run.userId,
          url: s.url,
          finalUrl: s.finalUrl,
          fetchedVia: s.fetchedVia,
          httpStatus: s.status,
          textLength: s.markdown.length,
          title: s.title,
          markdown: s.markdown,
          fetchedAt: s.fetchedAt,
        }))).returning({ id: articleSources.id })
      : [];
    const evidence = result.rows.length
      ? await tx.insert(articleEvidence).values(result.rows.map((r) => ({
          runId: run.id,
          userId: run.userId,
          sourceId: stored[r.sourceIndex]!.id,
          claim: r.claim,
          quote: r.quote,
          kind: r.kind,
          verified: r.verified,
          method: r.method,
          ratio: r.ratio,
          reason: r.reason,
        }))).returning({ id: articleEvidence.id })
      : [];
    // `returning` keeps insert order, so claim ids follow the extraction order.
    return evidence.map((e, i) => ({ claimId: `c${i + 1}`, evidenceId: e.id, verified: result.rows[i]!.verified }));
  });
}

function shortfall(result: ResearchResult, verified: number, needs: number): string {
  const tally = new Map<string, number>();
  for (const r of result.rows) if (!r.verified) tally.set(r.reason ?? "unknown", (tally.get(r.reason ?? "unknown") ?? 0) + 1);
  const rejected = [...tally].map(([k, n]) => `${k}: ${n}`).join(", ") || "none";
  return `research found ${verified} verified claims (needs ${needs}); ${result.sources.length} usable sources (${result.skipped} skipped after model errors), ${result.rows.length} claims extracted; rejected: ${rejected}`;
}

export const researchStage: Stage<ResearchInput, ResearchOutput> = {
  key: "research",
  promptVersion: await promptVersion("research-queries", "research-claims"),
  async input({ run }) {
    if (run.sourceType !== "article_keyword" && run.sourceType !== "article_title") throw new StageInputError(`Unsupported source type ${run.sourceType}`);
    const r = MODE_PRESETS[run.mode as EngineMode]?.research;
    if (!r) throw new StageInputError(`Unsupported mode ${run.mode}`);
    return {
      topic: run.topic,
      sourceType: run.sourceType,
      locale: run.locale,
      maxQueries: r.maxQueries,
      maxPages: r.maxPages,
      maxClaimsPerPage: r.maxClaimsPerPage,
      minVerifiedClaims: r.minVerifiedClaims,
    };
  },
  async run(input, ctx): Promise<StageOutcome<ResearchOutput>> {
    const usages: Usage[] = [];
    const result = await researchCore(input, ctx, usages);
    const verified = result.rows.filter((r) => r.verified).length;
    if (verified < input.minVerifiedClaims) throw new Error(shortfall(result, verified, input.minVerifiedClaims));
    const claims = await persist(ctx, result);
    return {
      next: { type: "advance", to: "brief" },
      output: {
        queries: result.queries,
        sourceCount: result.sources.length,
        skippedSources: result.skipped,
        searchAdapter: ctx.deps.search.name,
        claimCount: result.rows.length,
        verifiedCount: verified,
        claims,
      },
      usage: usages,
    };
  },
};
