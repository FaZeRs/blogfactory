import { briefComponents } from "../../components/guide.js";
import { ENGINE_CONFIG } from "../../config.js";
import { componentProfile, type ComponentProfile } from "../../profile.js";
import type { KeywordOverview } from "../../adapters/types.js";
import { MODE_PRESETS } from "../../modes.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage, StageContext } from "../../runtime/stage.js";
import { StageInputError, type EngineMode } from "../../types.js";
import { sanitizeText, truncate } from "../../util.js";
import { NO_RULES, styleRulesText } from "../../../services/learning/rules.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { evidenceText, latestStageOutput, linksText, loadEvidence, loadSources, modelFor, writerVoice, type LinkCandidate, type PromptEvidence, refreshCurrentText, NO_CURRENT } from "../shared.js";
import type { ResearchOutput, SerpAnalysis } from "../research/schema.js";
import { BriefModelSchema, PLAN, fitLengthPlan, planTarget, repairBrief, validateBrief, type Brief, type BriefOutput } from "./schema.js";

export type BriefInput = {
  topic: string;
  locale: string;
  sourceType: string;
  voice: string;
  evidence: PromptEvidence[];
  links: LinkCandidate[];
  keywordData: boolean;
  minClaims: number;
  /** Angle and instructions the editor typed on Create Content; planning guidance, never facts. */
  guidance?: string;
  /** The component profile frozen at run start; missing means "markdown". */
  profile?: ComponentProfile;
  /** The owner's approved learned rules for English drafts, as a prompt block (`styleRulesText`); missing means none. */
  styleRules?: string;
  /** For a refresh run, the post being updated (`refreshCurrentText`); missing for a new article. */
  current?: string;
  /** What the ranking pages cover and miss, and the questions people ask; absent when the competitor step found nothing. */
  serp?: SerpAnalysis | null;
  questions?: string[];
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

export function editorGuidance(settings: unknown): string {
  const g = (settings as { guidance?: { angle?: unknown; instructions?: unknown } } | null)?.guidance;
  const angle = typeof g?.angle === "string" ? g.angle.trim() : "";
  const instructions = typeof g?.instructions === "string" ? g.instructions.trim() : "";
  return [angle && `Angle: ${angle}`, instructions && `Instructions: ${instructions}`].filter(Boolean).join("\n");
}

const MAX_RELATED = 10;

export const keywordText = (k: KeywordOverview | null, related: KeywordOverview[] = []) =>
  [
    k ? `Search volume: ${k.volume ?? "unknown"}; difficulty: ${k.difficulty ?? "unknown"}; intent: ${k.intent ?? "unknown"}; AI overview: ${k.aiOverview ? "yes" : "no"}` : "No keyword data.",
    related.length ? `Related searches (monthly volume):\n${related.map((r) => `- ${r.keyword} (${r.volume ?? "unknown"})`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

const STOP_WORDS = new Set(["the", "and", "for", "with", "how", "what", "why", "when", "best", "your", "you", "are", "can", "does", "from", "into", "that", "this", "vs", "versus"]);
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

/** Related searches other than the topic itself that share a word with it, highest volume first. */
export function relatedSearches(found: KeywordOverview[], topic: string): KeywordOverview[] {
  const seen = new Set([topic.trim().toLowerCase()]);
  const topicWords = new Set(words(topic));
  return [...found]
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .filter((k) => {
      const key = k.keyword.trim().toLowerCase();
      // Broad matches ("vps hosting" for an n8n topic) share no word with the topic.
      return key.length >= 2 && key.length <= 80 && words(key).some((w) => topicWords.has(w)) && !seen.has(key) && seen.add(key);
    })
    .slice(0, MAX_RELATED);
}

/** The analysis as brief-prompt text. Its words are model output over untrusted pages, so the caller fences it. */
export function serpText(serp: SerpAnalysis | null | undefined, questions: string[] = [], target: number | null = null): string {
  if (!serp && !questions.length) return "None.";
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- none");
  return [
    serp && `Search intent: ${serp.searchIntent}`,
    serp && `Covered by every competitor (cover briefly):\n${list(serp.coveredTopics)}`,
    serp && `Gaps (give them sections):\n${list(serp.gaps)}`,
    serp && `Information gain (build sections around these${serp.informationGain.length ? "; claim ids in brackets" : ""}):\n${list(serp.informationGain.map((g) => `${g.point}${g.claimIds.length ? ` [${g.claimIds.join(", ")}]` : ""}`))}`,
    questions.length ? `Questions people ask (FAQ candidates):\n${list(questions)}` : "",
    target ? `Target length: about ${target} words in total.` : "",
  ].filter(Boolean).join("\n\n");
}

export const briefStage: Stage<BriefInput, BriefOutput> = {
  key: "brief",
  promptVersion: await promptVersion("brief"),
  async input({ run }) {
    const r = MODE_PRESETS[run.mode as EngineMode]?.research;
    if (!r) throw new StageInputError(`Unsupported mode ${run.mode}`);
    const [evidence, sources, settings, research, styleRules, current] = await Promise.all([loadEvidence(run), loadSources(run), getEffectiveSettings(run.userId, run.siteId), latestStageOutput<ResearchOutput>(run, "research"), styleRulesText(run.userId, run.siteId, "draft"), refreshCurrentText(run)]);
    const urlOf = new Map(sources.map((s) => [s.id, s.finalUrl]));
    const verified = evidence.filter((e) => e.verified);
    if (verified.length === 0) throw new StageInputError("no verified evidence; research did not finish");
    return {
      topic: run.topic,
      locale: run.locale,
      sourceType: run.sourceType,
      voice: writerVoice(settings as never, run.topic),
      evidence: verified.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" })),
      links: linkCandidates(settings),
      guidance: editorGuidance(run.settings),
      profile: componentProfile(run),
      styleRules,
      ...(current ? { current } : {}),
      serp: research.serpAnalysis ?? null,
      questions: research.questions ?? [],
      keywordData: r.useKeywordData,
      minClaims: Math.min(r.minVerifiedClaims, verified.length),
    };
  },
  async run(input, ctx: StageContext) {
    const { llm, dataForSeo, now } = ctx.deps;
    // One keyword lookup and one related-searches lookup. A failure or an unknown keyword just means no keyword data.
    let keyword: KeywordOverview | null = null;
    let related: KeywordOverview[] = [];
    if (input.keywordData && dataForSeo) {
      const opts = { locale: input.locale, signal: ctx.signal };
      [keyword, related] = await Promise.all([
        dataForSeo.keywordOverview(input.topic, opts).catch(() => null),
        dataForSeo.relatedKeywords(input.topic, { ...opts, limit: 30 }).then((found) => relatedSearches(found, input.topic)).catch(() => []),
      ]);
    }
    const lindevo = input.profile === "lindevo";
    const target = planTarget(input.serp?.typicalLength);
    const takeaways = lindevo ? PLAN.lindevoTakeaways : PLAN.takeaways;
    const prompt = await preparePrompt("brief", {
      dataRule: DATA_RULE,
      components: briefComponents(lindevo),
      voice: input.voice || "No custom voice rules.",
      styleRules: input.styleRules ?? NO_RULES,
      current: input.current ? fenceData("current-article", input.current) : NO_CURRENT,
      openingWords: PLAN.openingWords,
      faqWordsEach: PLAN.faqWordsEach,
      planMinWords: PLAN.limits.min,
      planMaxWords: PLAN.limits.max,
      maxWords: ENGINE_CONFIG.gates.maxWords,
      faqMin: PLAN.faq.min,
      faqMax: PLAN.faq.max,
      takeawaysMin: takeaways.min,
      takeawaysMax: takeaways.max,
      titleMax: ENGINE_CONFIG.gates.titleMax,
      descriptionMax: ENGINE_CONFIG.gates.descriptionMax,
      topic: fenceData("topic", input.topic),
      evidence: fenceData("evidence", evidenceText(input.evidence)),
      links: linksText(input.links),
      serp: fenceData("serp-analysis", serpText(input.serp, input.questions, target)),
      search: fenceData("keyword-data", keywordText(keyword, related)),
      guidance: fenceData("editor-direction", input.guidance || "None."),
      today: now().toISOString().slice(0, 10),
    });
    const relatedSet = new Set(related.map((r) => r.keyword.toLowerCase()));
    const check = { links: new Set(input.links.map((l) => l.url)), verifiedIds: new Set(input.evidence.map((e) => e.id)), minClaims: input.minClaims, profile: input.profile };
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
        maxTokens: 16_000,
        signal: ctx.signal,
      });
      usage.push({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd });
      const planned = repairBrief(fitLengthPlan(r.value, target));
      // Only searches the keyword data offered: a secondary keyword the model made up has no demand behind it.
      const brief: Brief = { ...planned, secondaryKeywords: [...new Set((planned.secondaryKeywords ?? []).filter((k) => relatedSet.has(k.trim().toLowerCase())).map((k) => k.trim()))].slice(0, 5) };
      issues = validateBrief(brief, check).map(sanitizeText);
      if (issues.length === 0) {
        // Long topics rarely have search data; the chosen keyword usually does. Recorded for the reviewer, not the prompt.
        if (!keyword && input.keywordData && dataForSeo && brief.primaryKeyword.toLowerCase() !== input.topic.toLowerCase()) {
          keyword = await dataForSeo.keywordOverview(brief.primaryKeyword, { locale: input.locale, signal: ctx.signal }).catch(() => null);
        }
        const relatedKeywords = related.map((r) => ({ keyword: r.keyword, volume: r.volume }));
        return { next: { type: "advance", to: "draft" }, output: { ...brief, keywordData: keyword, relatedKeywords }, usage };
      }
      // The problems quote model text that began as untrusted evidence, so the list is data too.
      feedback = `\n\n## Your previous brief had these problems. Fix every one and return the whole brief again.\n${fenceData("issues", issues.map((i) => `- ${i}`).join("\n"))}`;
    }
    throw new Error(truncate(sanitizeText(`brief failed validation twice: ${issues.join("; ")}`), FAILURE_MAX));
  },
};
