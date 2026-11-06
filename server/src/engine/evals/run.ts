import { z } from "zod";
import type { EngineLlm } from "../adapters/llm.js";
import { renderCitations } from "../citations.js";
import { ENGINE_CONFIG } from "../config.js";
import { gateBlockers } from "../gates/types.js";
import { runCodeGates } from "../gates/index.js";
import { MODEL_ROLES, resolveRunSettings } from "../modes.js";
import { DATA_RULE, fenceData, preparePrompt } from "../prompts/load.js";
import type { ArticleRunRow, StageContext } from "../runtime/stage.js";
import { briefStage, type BriefInput } from "../stages/brief/index.js";
import { draftStage, type DraftInput } from "../stages/draft/index.js";
import { reviewDraft } from "../stages/review/index.js";
import { reviseStage } from "../stages/revise/index.js";
import { evidenceText, normalizeDraftMarkdown } from "../stages/shared.js";
import { RateLimitError, type EngineMode, type ModelRole } from "../types.js";
import { mapLimit, sanitizeText, sha256Hex, truncate } from "../util.js";
import { buildWriterSystemPrompt } from "../../services/generation-contracts.js";
import { EVAL_THRESHOLDS, RUBRIC_DIMENSIONS, decideRules, type RubricDimension, type VariantSummary } from "./decide.js";
import { frozenEvidence, type EvalBrief } from "./schema.js";

/**
 * A mode, optionally with one model for every role and `#noreview` to skip the review stage:
 * `normal@deepseek/deepseek-v4-flash#noreview`.
 */
export type EvalMode = "fast" | EngineMode | `${"fast" | EngineMode}${"@" | "#"}${string}`;

export function parseEvalMode(mode: string): { base: "fast" | EngineMode; model?: string; review: boolean } {
  const hash = mode.indexOf("#");
  const flag = hash < 0 ? "" : mode.slice(hash + 1);
  if (flag && flag !== "noreview") throw new Error(`Unknown flag "#${flag}" in mode "${mode}" (only #noreview)`);
  const spec = hash < 0 ? mode : mode.slice(0, hash);
  const at = spec.indexOf("@");
  const base = at < 0 ? spec : spec.slice(0, at);
  if (base !== "fast" && base !== "normal" && base !== "deep") throw new Error(`Unknown mode "${mode}" (fast, normal or deep, optionally @<model id> and #noreview)`);
  const model = at < 0 ? undefined : spec.slice(at + 1).trim();
  if (at >= 0 && !model) throw new Error(`Mode "${mode}" names no model after @`);
  return { base, model, review: flag !== "noreview" };
}
export type Verdict = "win" | "loss" | "tie";

/** Plain-text completion, what fast mode does: no JSON schema. */
export type ChatFn = (req: { model: string; system: string; user: string; maxTokens: number; signal?: AbortSignal }) => Promise<{ text: string; costUsd: number }>;

export type EvalDeps = {
  llm: EngineLlm;
  chat: ChatFn;
  judgeModel: string;
  now?: () => Date;
  signal?: AbortSignal;
};

// The judge is not a pipeline stage: the engine's role union stays as it is, and only the request's label differs.
const JUDGE = "judge" as ModelRole;
const FAST_MAX_TOKENS = 12_000;
const CONCURRENCY = 2;
const SITE_URL = "https://eval.example";

const score = z.number().int().min(1).max(10);
export const RubricSchema = z.object({
  accuracy: score,
  clarity: score,
  // No length limit: judges overrun one often, and only the scores and winner are kept.
  note: z.string(),
  specificity: score,
  usefulness: score,
  voice: score,
});
export const PairwiseSchema = z.object({ reason: z.string(), winner: z.enum(["A", "B", "tie"]) });

export type EvalDraft = {
  briefId: string;
  mode: EvalMode;
  title: string;
  description: string;
  markdown: string;
  failedGates: string[];
  passed: boolean;
  rubric: Record<RubricDimension, number>;
  costUsd: number;
  /** Set when generation threw: the slot is scored as a failure, not skipped. */
  error?: string;
};

const lowest = () => Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 1])) as Record<RubricDimension, number>;

const RATE_LIMIT_RETRIES = 5;

function metered(llm: EngineLlm) {
  const meter = { costUsd: 0 };
  const wrapped: EngineLlm = {
    async json(req) {
      // Free models rate-limit often; one 429 must not end a whole eval.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const r = await llm.json(req);
          meter.costUsd += r.costUsd;
          return r;
        } catch (e) {
          if (!(e instanceof RateLimitError) || attempt >= RATE_LIMIT_RETRIES) throw e;
          await new Promise((resolve) => setTimeout(resolve, Math.min(e.retryAfterMs ?? 20_000, 60_000)));
        }
      }
    },
  };
  return { llm: wrapped, meter };
}

type Generated = { title: string; description: string; markdown: string; failedGates: string[] };

/** The same code gates the engine runs, with link checks stubbed: an eval never touches the network. */
async function gate(parts: { title: string; description: string; raw: string; markdown: string }, frozen: ReturnType<typeof frozenEvidence>, evidence = frozen.evidence) {
  const results = await runCodeGates(
    { ...parts, evidence, sources: frozen.sources, siteUrl: SITE_URL, existingPosts: [] },
    { config: ENGINE_CONFIG, checkLink: async () => 200 },
  );
  return gateBlockers(results);
}

const uniqueGates = (blockers: { gate: string }[]) => [...new Set(blockers.map((b) => b.gate))];

/** Brief, draft, gates, review and revise from the frozen evidence: the stages' own `run`, no database. */
export async function generateEngineArticle(brief: EvalBrief, mode: EngineMode, llm: EngineLlm, deps: Pick<EvalDeps, "now" | "signal"> = {}, model?: string, review = true): Promise<Generated> {
  const now = deps.now ?? (() => new Date());
  // Stages read models from the run's settings, as a site's engine settings would set them.
  const runSettingsValue = model ? { models: Object.fromEntries(MODEL_ROLES.map((role) => [role, model])) } : {};
  const settings = resolveRunSettings(mode, runSettingsValue);
  const frozen = frozenEvidence(brief, now());
  const verified = frozen.evidence.filter((e) => e.verified);
  if (verified.length < settings.preset.research.minVerifiedClaims) {
    throw new Error(`only ${verified.length} verified claims (needs ${settings.preset.research.minVerifiedClaims})`);
  }
  const urlOf = new Map(frozen.sources.map((s) => [s.id, s.finalUrl]));
  const evidence = verified.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" }));
  const run = { id: "eval", userId: "eval", siteId: "eval", mode, settings: runSettingsValue, locale: brief.locale, topic: brief.topic, sourceType: "article_keyword", reviseCount: 0 } as unknown as ArticleRunRow;
  const ctx = (reviseCount: number): StageContext => ({
    run: { ...run, reviseCount },
    attempt: 1,
    signal: deps.signal ?? new AbortController().signal,
    deps: { llm, search: {} as never, reader: {} as never, dataForSeo: null, now, stages: {} as never },
  });

  const briefInput: BriefInput = {
    topic: brief.topic,
    locale: brief.locale,
    sourceType: "article_keyword",
    voice: "",
    evidence,
    links: [],
    keywordData: false,
    minClaims: Math.min(settings.preset.research.minVerifiedClaims, verified.length),
  };
  const planned = (await briefStage.run(briefInput, ctx(0))).output;
  const draftInput: DraftInput = {
    locale: brief.locale,
    voice: "",
    brief: planned,
    evidence,
    sources: frozen.sources.map(({ id, url, finalUrl, title }) => ({ id, url, finalUrl, title })),
    evidenceSources: Object.fromEntries(verified.map((e) => [e.id, e.sourceId])),
    citationStyle: settings.citationStyle,
  };
  let draft = (await draftStage.run(draftInput, ctx(0))).output;
  let revisions = 0;
  let previous: number | null = null;
  let previousReview: number | null = null;
  for (;;) {
    const markdown = renderCitations(draft.markdown, frozen.evidence, frozen.sources, settings.citationStyle, brief.locale);
    let blockers = await gate({ title: draft.title, description: draft.description, raw: draft.markdown, markdown }, frozen);
    if (blockers.length === 0 && review && settings.preset.review.length) {
      // The paid review checks read only a draft the code gates passed, as in the engine.
      const { outcome } = await reviewDraft({ ...draftInput, draft, previousBlockers: previousReview, reviseCount: revisions }, ctx(revisions));
      if (outcome.next.type !== "advance" || outcome.next.to === "deliver") {
        return { title: draft.title, description: draft.description, markdown, failedGates: uniqueGates(outcome.output.escalated ? outcome.output.blockers : []) };
      }
      blockers = outcome.output.blockers;
      previousReview = blockers.length;
    } else {
      // Same stop rules as the gates stage: revise loops are spent, or the last revision did not shrink the list.
      const stalled = previous !== null && blockers.length >= previous;
      if (blockers.length === 0 || revisions >= settings.preset.maxRevise || stalled) {
        return { title: draft.title, description: draft.description, markdown, failedGates: uniqueGates(blockers) };
      }
    }
    previous = blockers.length;
    draft = (await reviseStage.run({ ...draftInput, draft, blockers }, ctx(revisions))).output;
    revisions += 1;
  }
}

/** The fast-mode user message for a keyword article (generate-content.ts `buildDraftUserMessage`, article_keyword branch). */
const fastUserMessage = (topic: string) =>
  `Write a complete, publish-ready SEO article for this target keyword: "${topic}".\n\nGenerate an SEO-optimized H1 title that matches search intent, then write the article in markdown with a clear intro, useful H2/H3 structure, and a concise conclusion.`;

/**
 * Fast mode's writer call without the database: the same system prompt and draft message, no research.
 * The gates run on the result; with no evidence behind it, the citation gate is expected to fail.
 */
export async function generateArticleForEval(brief: EvalBrief, model: string, deps: Pick<EvalDeps, "chat" | "now" | "signal">): Promise<Generated & { costUsd: number }> {
  const reply = await deps.chat({ model, system: buildWriterSystemPrompt(), user: fastUserMessage(brief.topic), maxTokens: FAST_MAX_TOKENS, signal: deps.signal });
  const text = sanitizeText(reply.text);
  const title = /^\s*#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? brief.topic;
  const markdown = normalizeDraftMarkdown(text);
  const lead = markdown.split("\n").find((l) => l.trim() && !/^[#>|*\-\s]/.test(l)) ?? "";
  const description = truncate(lead.trim(), ENGINE_CONFIG.gates.descriptionMax);
  const frozen = frozenEvidence(brief, (deps.now ?? (() => new Date()))());
  const blockers = await gate({ title, description, raw: markdown, markdown }, frozen, []);
  return { title, description, markdown, failedGates: uniqueGates(blockers), costUsd: reply.costUsd };
}

const promptEvidence = (brief: EvalBrief, now: Date) => {
  const frozen = frozenEvidence(brief, now);
  const urlOf = new Map(frozen.sources.map((s) => [s.id, s.finalUrl]));
  return fenceData("evidence", evidenceText(frozen.evidence.filter((e) => e.verified).map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" }))));
};
const article = (d: { title: string; markdown: string }) => `# ${d.title}\n\n${d.markdown}`;

export async function judgeRubric(llm: EngineLlm, judgeModel: string, brief: EvalBrief, d: { title: string; markdown: string }, now = new Date()): Promise<Record<RubricDimension, number>> {
  const p = await preparePrompt("judge-rubric", {
    dataRule: DATA_RULE,
    voice: "No custom voice rules.",
    topic: fenceData("topic", brief.topic),
    evidence: promptEvidence(brief, now),
    article: fenceData("draft", article(d)),
  });
  const { value } = await llm.json({ role: JUDGE, model: judgeModel, system: p.system, user: p.user, schema: RubricSchema, maxTokens: 600 });
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((k) => [k, value[k]])) as Record<RubricDimension, number>;
}

/** Randomized but reproducible A/B order, so a judge's position bias cannot favour either variant. */
export function candidateFirst(seed: string): boolean {
  return Number.parseInt(sha256Hex(seed).slice(0, 2), 16) % 2 === 0;
}

export async function judgePairwise(llm: EngineLlm, judgeModel: string, brief: EvalBrief, baseline: EvalDraft, candidate: EvalDraft, now = new Date()): Promise<Verdict> {
  // A slot with no article cannot be compared: the other side wins, or it is a tie.
  if (!candidate.markdown) return baseline.markdown ? "loss" : "tie";
  if (!baseline.markdown) return "win";
  const candidateIsA = candidateFirst(`${brief.id}:${candidate.mode}`);
  const [a, b] = candidateIsA ? [candidate, baseline] : [baseline, candidate];
  const p = await preparePrompt("judge-pairwise", {
    dataRule: DATA_RULE,
    voice: "No custom voice rules.",
    topic: fenceData("topic", brief.topic),
    evidence: promptEvidence(brief, now),
    a: fenceData("draft-a", article(a)),
    b: fenceData("draft-b", article(b)),
  });
  const { value } = await llm.json({ role: JUDGE, model: judgeModel, system: p.system, user: p.user, schema: PairwiseSchema, maxTokens: 800 });
  if (value.winner === "tie") return "tie";
  return (value.winner === "A") === candidateIsA ? "win" : "loss";
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(drafts: readonly EvalDraft[]): VariantSummary {
  const n = Math.max(1, drafts.length);
  const dimensions = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, round3(drafts.reduce((s, x) => s + x.rubric[d], 0) / n)])) as Record<RubricDimension, number>;
  return {
    dimensions,
    gatePassRate: round3(drafts.filter((d) => d.passed).length / n),
    meanScore: round3(RUBRIC_DIMENSIONS.reduce((s, d) => s + dimensions[d], 0) / RUBRIC_DIMENSIONS.length),
  };
}

export type EvalResult = EvalDraft & { pairwise?: Verdict };
export type ModeSummary = VariantSummary & {
  costUsd: number;
  failures: number;
  pairwise?: { wins: number; losses: number; ties: number };
  /** Whether the mode clears the bar against the baseline (candidates only). */
  decision?: { apply: boolean; reasons: string[] };
};
export type EvalReport = {
  startedAt: string;
  judgeModel: string;
  baseline: EvalMode;
  modes: EvalMode[];
  briefs: { id: string; topic: string; results: Record<string, EvalResult> }[];
  summary: Record<string, ModeSummary>;
  /** One line per candidate mode, e.g. `normal vs fast: 7-2-1` (wins-losses-ties). */
  lines: string[];
  judgeCostUsd: number;
};

async function draftFor(brief: EvalBrief, mode: EvalMode, deps: EvalDeps, judge: EngineLlm, fastModel: string): Promise<EvalDraft> {
  const gen = metered(deps.llm);
  try {
    let costUsd = 0;
    let g: Generated;
    const { base, model, review } = parseEvalMode(mode);
    if (base === "fast") {
      const fast = await generateArticleForEval(brief, model ?? fastModel, deps);
      costUsd = fast.costUsd;
      g = fast;
    } else {
      g = await generateEngineArticle(brief, base, gen.llm, deps, model, review);
      costUsd = gen.meter.costUsd;
    }
    const rubric = await judgeRubric(judge, deps.judgeModel, brief, g, deps.now?.());
    return { briefId: brief.id, mode, title: g.title, description: g.description, markdown: g.markdown, failedGates: g.failedGates, passed: g.failedGates.length === 0, rubric, costUsd };
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { briefId: brief.id, mode, title: "", description: "", markdown: "", failedGates: [`generation: ${error}`], passed: false, rubric: lowest(), costUsd: gen.meter.costUsd, error };
  }
}

/** Runs every brief in every mode (the first is the baseline), judges rubric and pairwise, and builds the report. */
export async function runEval(briefs: EvalBrief[], modes: EvalMode[], deps: EvalDeps, opts: { fastModel: string }): Promise<EvalReport> {
  const [baseline, ...candidates] = modes;
  if (!baseline) throw new Error("runEval needs at least one mode");
  const judge = metered(deps.llm);
  const rows = await mapLimit(briefs, CONCURRENCY, async (brief) => {
    const drafts = await Promise.all(modes.map((m) => draftFor(brief, m, deps, judge.llm, opts.fastModel)));
    const results: Record<string, EvalResult> = Object.fromEntries(drafts.map((d) => [d.mode, d as EvalResult]));
    await Promise.all(candidates.map(async (m) => {
      results[m]!.pairwise = await judgePairwise(judge.llm, deps.judgeModel, brief, results[baseline]!, results[m]!, deps.now?.());
    }));
    return { id: brief.id, topic: brief.topic, results };
  });

  const summary: Record<string, ModeSummary> = {};
  const lines: string[] = [];
  for (const mode of modes) {
    const drafts = rows.map((r) => r.results[mode]!);
    summary[mode] = { ...summarize(drafts), costUsd: round3(drafts.reduce((s, d) => s + d.costUsd, 0)), failures: drafts.filter((d) => d.error).length };
  }
  for (const mode of candidates) {
    const verdicts = rows.map((r) => r.results[mode]!.pairwise!);
    const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
    const [wins, losses, ties] = [count("win"), count("loss"), count("tie")];
    const rate = rows.length ? (wins + ties / 2) / rows.length : 0;
    summary[mode] = { ...summary[mode]!, pairwise: { wins, losses, ties }, decision: decideRules(summary[baseline]!, summary[mode]!, rate, EVAL_THRESHOLDS) };
    lines.push(`${mode} vs ${baseline}: ${wins}-${losses}-${ties}`);
  }
  return { startedAt: (deps.now?.() ?? new Date()).toISOString(), judgeModel: deps.judgeModel, baseline, modes, briefs: rows, summary, lines, judgeCostUsd: round3(judge.meter.costUsd) };
}
