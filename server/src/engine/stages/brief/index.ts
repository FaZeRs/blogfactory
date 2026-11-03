import { ENGINE_CONFIG } from "../../config.js";
import type { KeywordOverview } from "../../adapters/types.js";
import { MODE_PRESETS } from "../../modes.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage, StageContext } from "../../runtime/stage.js";
import { StageInputError, type EngineMode } from "../../types.js";
import { sanitizeText, truncate } from "../../util.js";
import { buildVoiceContentInstructions } from "../../../services/voice-content.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { evidenceText, linksText, loadEvidence, loadSources, modelFor, type LinkCandidate, type PromptEvidence } from "../shared.js";
import { BriefModelSchema, PLAN, fitLengthPlan, validateBrief, type Brief, type BriefOutput } from "./schema.js";

export type BriefInput = {
  topic: string;
  locale: string;
  sourceType: string;
  voice: string;
  evidence: PromptEvidence[];
  links: LinkCandidate[];
  keywordData: boolean;
  minClaims: number;
};

const MAX_LINK_CANDIDATES = 60;
const ROUNDS = 2;
const FAILURE_MAX = 1000;

/** Internal link candidates come from the site's link index only; nothing else is offered to the model. */
export function linkCandidates(settings: unknown): LinkCandidate[] {
  const pages = (settings as { internalLinkIndex?: { pages?: { url?: unknown; title?: unknown }[] } } | null)?.internalLinkIndex?.pages ?? [];
  const seen = new Set<string>();
  return pages.flatMap((p) => {
    if (typeof p.url !== "string" || !p.url || seen.has(p.url)) return [];
    seen.add(p.url);
    return [{ url: p.url, title: typeof p.title === "string" ? truncate(sanitizeText(p.title), 120) : p.url }];
  }).slice(0, MAX_LINK_CANDIDATES);
}

export const keywordText = (k: KeywordOverview | null) =>
  k ? `Search volume: ${k.volume ?? "unknown"}; difficulty: ${k.difficulty ?? "unknown"}; intent: ${k.intent ?? "unknown"}; AI overview: ${k.aiOverview ? "yes" : "no"}` : "No keyword data.";

export const briefStage: Stage<BriefInput, BriefOutput> = {
  key: "brief",
  promptVersion: await promptVersion("brief"),
  async input({ run }) {
    const r = MODE_PRESETS[run.mode as EngineMode]?.research;
    if (!r) throw new StageInputError(`Unsupported mode ${run.mode}`);
    const [evidence, sources, settings] = await Promise.all([loadEvidence(run), loadSources(run), getEffectiveSettings(run.userId, run.siteId)]);
    const urlOf = new Map(sources.map((s) => [s.id, s.finalUrl]));
    const verified = evidence.filter((e) => e.verified);
    if (verified.length === 0) throw new StageInputError("no verified evidence; research did not finish");
    return {
      topic: run.topic,
      locale: run.locale,
      sourceType: run.sourceType,
      voice: buildVoiceContentInstructions(settings as never).join("\n"),
      evidence: verified.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" })),
      links: linkCandidates(settings),
      keywordData: r.useKeywordData,
      minClaims: Math.min(r.minVerifiedClaims, verified.length),
    };
  },
  async run(input, ctx: StageContext) {
    const { llm, dataForSeo, now } = ctx.deps;
    // Deep mode only: one keyword lookup. A failure or an unknown keyword just means no keyword data.
    let keyword: KeywordOverview | null = null;
    if (input.keywordData && dataForSeo) {
      keyword = await dataForSeo.keywordOverview(input.topic, { locale: input.locale, signal: ctx.signal }).catch(() => null);
    }
    const prompt = await preparePrompt("brief", {
      dataRule: DATA_RULE,
      voice: input.voice || "No custom voice rules.",
      openingWords: PLAN.openingWords,
      faqWordsEach: PLAN.faqWordsEach,
      planMinWords: PLAN.limits.min,
      planMaxWords: PLAN.limits.max,
      maxWords: ENGINE_CONFIG.gates.maxWords,
      faqMin: PLAN.faq.min,
      faqMax: PLAN.faq.max,
      takeawaysMin: PLAN.takeaways.min,
      takeawaysMax: PLAN.takeaways.max,
      titleMax: ENGINE_CONFIG.gates.titleMax,
      descriptionMax: ENGINE_CONFIG.gates.descriptionMax,
      topic: fenceData("topic", input.topic),
      evidence: fenceData("evidence", evidenceText(input.evidence)),
      links: linksText(input.links),
      search: fenceData("keyword-data", keywordText(keyword)),
      today: now().toISOString().slice(0, 10),
    });
    const check = { links: new Set(input.links.map((l) => l.url)), verifiedIds: new Set(input.evidence.map((e) => e.id)), minClaims: input.minClaims };
    const usage: NonNullable<Awaited<ReturnType<Stage<unknown, unknown>["run"]>>["usage"]> = [];
    let feedback = "";
    let issues: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const r = await llm.json({
        role: "brief",
        model: modelFor(ctx.run, "brief"),
        system: prompt.system,
        user: prompt.user + feedback,
        schema: BriefModelSchema,
        maxTokens: 6000,
        signal: ctx.signal,
      });
      usage.push({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd });
      const brief: Brief = fitLengthPlan(r.value);
      issues = validateBrief(brief, check).map(sanitizeText);
      if (issues.length === 0) {
        return { next: { type: "advance", to: "draft" }, output: { ...brief, keywordData: keyword }, usage };
      }
      // The problems quote model text that began as untrusted evidence, so the list is data too.
      feedback = `\n\n## Your previous brief had these problems. Fix every one and return the whole brief again.\n${fenceData("issues", issues.map((i) => `- ${i}`).join("\n"))}`;
    }
    throw new Error(truncate(sanitizeText(`brief failed validation twice: ${issues.join("; ")}`), FAILURE_MAX));
  },
};
