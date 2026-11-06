import type { SearchHit } from "../../adapters/types.js";
import { DATA_RULE, fenceData, preparePrompt } from "../../prompts/load.js";
import type { StageContext } from "../../runtime/stage.js";
import { RateLimitError } from "../../types.js";
import { sanitizeText, wordCount } from "../../util.js";
import { modelFor } from "../shared.js";
import { SerpAnalysisModelSchema, type Competitor, type SerpAnalysis } from "./schema.js";

const MAX_HEADINGS = 40;
const MAX_QUESTIONS = 12;
const PAGE_MIN_CHARS = 400;
const FETCH_LIMIT = 10;

/** Pure: title (first H1), H2/H3 outline and word count of a page's markdown. Headings inside code fences are ignored. */
export function competitorOutline(markdown: string): { title: string | null; outline: Competitor["outline"]; words: number } {
  let fenced = false;
  let title: string | null = null;
  const outline: Competitor["outline"] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = sanitizeText(m[2]!.replace(/[*_`[\]]/g, "")).slice(0, 160);
    if (!text) continue;
    if (m[1]!.length === 1) title ??= text;
    else if (outline.length < MAX_HEADINGS) outline.push({ level: m[1]!.length as 2 | 3, text });
  }
  return { title, outline, words: wordCount(markdown) };
}

/** Questions from SERP titles and snippets: every sentence-like span that ends with "?". */
export function serpQuestions(hits: SearchHit[]): string[] {
  const out = new Set<string>();
  for (const h of hits) for (const text of [h.title, h.snippet]) {
    for (const m of text.matchAll(/[^.!?\n]{8,}\?/g)) out.add(sanitizeText(m[0]).trim());
  }
  return [...out];
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const isOwn = (url: string, domain: string | null) => {
  const own = (domain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
  const host = hostOf(url);
  return !!own && (host === own || host.endsWith(`.${own}`));
};
const median = (n: number[]) => (n.length ? [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)]! : null);

export type CompetitorResult = { competitors: Competitor[]; questions: string[]; serpAnalysis: SerpAnalysis | null };
type Spent = { model: string; promptTokens: number; completionTokens: number; costUsd: number }[];

/**
 * Reads the top organic results for the topic (not the site itself), outlines them in code and asks the model for the
 * gaps. Any failure leaves research intact: the caller gets `null` analysis and whatever was collected.
 */
export async function analyzeSerp(
  args: { topic: string; locale: string; maxCompetitors: number; siteDomain: string | null; claims: { id: string; claim: string }[]; deep: boolean },
  ctx: StageContext,
  spent: Spent,
): Promise<CompetitorResult> {
  const { search, reader, dataForSeo, llm } = ctx.deps;
  const empty: CompetitorResult = { competitors: [], questions: [], serpAnalysis: null };
  try {
    // Deep mode reads the SERP from DataForSEO when it is configured; otherwise the run's search client.
    const opts = { locale: args.locale, limit: FETCH_LIMIT, signal: ctx.signal };
    const hits = args.deep && dataForSeo ? await dataForSeo.serp(args.topic, opts) : await search.search(args.topic, opts);
    const questions = serpQuestions(hits);
    if (args.deep && dataForSeo) {
      for (const q of await dataForSeo.peopleAlsoAsk(args.topic, { locale: args.locale }).catch(() => [] as string[])) questions.unshift(sanitizeText(q));
    }
    const picks = [...new Set(hits.map((h) => h.url))].filter((u) => !isOwn(u, args.siteDomain)).slice(0, args.maxCompetitors);
    const titles = new Map(hits.map((h) => [h.url, h.title]));
    const competitors: Competitor[] = [];
    for (const url of picks) {
      try {
        const page = await reader.read(url, ctx.signal);
        if (page.status !== 200 || page.markdown.length < PAGE_MIN_CHARS) continue;
        const o = competitorOutline(page.markdown);
        competitors.push({ url: page.finalUrl || url, title: o.title ?? page.title ?? titles.get(url) ?? null, words: o.words, outline: o.outline });
      } catch {
        if (ctx.signal.aborted) throw new Error("research aborted");
      }
    }
    const result: CompetitorResult = { competitors, questions: [...new Set(questions)].slice(0, MAX_QUESTIONS), serpAnalysis: null };
    if (!competitors.length) return result;

    const prompt = await preparePrompt("serp-analysis", {
      dataRule: DATA_RULE,
      topic: fenceData("topic", args.topic),
      competitors: fenceData("competitors", competitors.map((c, i) =>
        [`${i + 1}. ${c.title ?? c.url} (${c.words} words)`, ...c.outline.map((h) => `${"  ".repeat(h.level - 1)}- ${h.text}`)].join("\n")).join("\n\n")),
      questions: fenceData("questions", result.questions.map((q) => `- ${q}`).join("\n") || "None."),
      claims: fenceData("claims", args.claims.map((c) => `[${c.id}] ${c.claim}`).join("\n") || "None."),
    });
    const r = await llm.json({
      role: "research_claims",
      model: modelFor(ctx.run, "research_claims"),
      system: prompt.system,
      user: prompt.user,
      schema: SerpAnalysisModelSchema,
      maxTokens: 6000,
      signal: ctx.signal,
    });
    spent.push({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd });
    const known = new Set(args.claims.map((c) => c.id));
    result.serpAnalysis = {
      ...r.value,
      informationGain: r.value.informationGain.map((g) => ({ ...g, claimIds: g.claimIds.filter((id) => known.has(id)) })),
      typicalLength: median(competitors.map((c) => c.words).filter((w) => w > 0)),
    };
    return result;
  } catch (error) {
    if (ctx.signal.aborted || error instanceof RateLimitError) throw error;
    console.warn(`[engine] competitor analysis skipped: ${(error as Error).message}`);
    return empty;
  }
}
