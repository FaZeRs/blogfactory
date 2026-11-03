import { ENGINE_CONFIG } from "../../config.js";
import { extractMarkerIds, renderCitationsDetailed } from "../../citations.js";
import { toPlainText } from "../../markdown/plain-text.js";
import { MODE_PRESETS } from "../../modes.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage } from "../../runtime/stage.js";
import { StageInputError, type EngineMode } from "../../types.js";
import { sanitizeText, wordCount } from "../../util.js";
import { MIN_FAQ_ANSWER_LENGTH } from "../../markdown/faq.js";
import { buildVoiceContentInstructions } from "../../../services/voice-content.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { PLAN, BriefOutputSchema, type BriefOutput } from "../brief/schema.js";
import { evidenceText, latestStageOutput, linksText, loadEvidence, loadSources, modelFor, normalizeDraftMarkdown, runSettings, type PromptEvidence } from "../shared.js";
import { DraftSchema, type DraftOutput } from "./schema.js";

export type DraftInput = {
  locale: string;
  voice: string;
  brief: BriefOutput;
  evidence: PromptEvidence[];
  /** Ids and URLs for citation rendering; page text is not part of the input. */
  sources: { id: string; url: string; finalUrl: string; title: string | null }[];
  evidenceSources: Record<string, string>;
  citationStyle: "inline" | "references";
};

/** The brief as the writer reads it: the keyword lookup is code data, not part of the plan. */
const briefForPrompt = ({ keywordData: _k, ...brief }: BriefOutput) => JSON.stringify(brief, null, 2);

export const draftStage: Stage<DraftInput, DraftOutput> = {
  key: "draft",
  promptVersion: await promptVersion("draft"),
  async input({ run }) {
    if (!MODE_PRESETS[run.mode as EngineMode]) throw new StageInputError(`Unsupported mode ${run.mode}`);
    const [stored, evidence, sources, settings] = await Promise.all([
      latestStageOutput<unknown>(run, "brief"),
      loadEvidence(run),
      loadSources(run),
      getEffectiveSettings(run.userId, run.siteId),
    ]);
    const brief = BriefOutputSchema.parse(stored);
    const urlOf = new Map(sources.map((s) => [s.id, s.finalUrl]));
    const verified = evidence.filter((e) => e.verified);
    return {
      locale: run.locale,
      voice: buildVoiceContentInstructions(settings as never).join("\n"),
      brief,
      evidence: verified.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" })),
      sources: sources.map((s) => ({ id: s.id, url: s.url, finalUrl: s.finalUrl, title: s.title })),
      evidenceSources: Object.fromEntries(verified.map((e) => [e.id, e.sourceId])),
      citationStyle: runSettings(run).citationStyle,
    };
  },
  async run(input, ctx) {
    const g = ENGINE_CONFIG.gates;
    const prompt = await preparePrompt("draft", {
      dataRule: DATA_RULE,
      locale: input.locale,
      voice: input.voice || "No custom voice rules.",
      planMinWords: PLAN.limits.min,
      planMaxWords: PLAN.limits.max,
      minWords: g.minWords,
      maxWords: g.maxWords,
      titleMax: g.titleMax,
      descriptionMax: g.descriptionMax,
      faqMinAnswerChars: Math.max(g.faqAnswerMin, MIN_FAQ_ANSWER_LENGTH),
      brief: fenceData("brief", briefForPrompt(input.brief)),
      evidence: fenceData("evidence", evidenceText(input.evidence)),
      // Only the links the brief chose, which came from the site's link index.
      links: linksText(input.brief.internalLinks.map((l) => ({ url: l.url, title: l.anchorText }))),
    });
    const r = await ctx.deps.llm.json({
      role: "draft",
      model: modelFor(ctx.run, "draft"),
      system: prompt.system,
      user: prompt.user,
      schema: DraftSchema,
      maxTokens: 12_000,
      signal: ctx.signal,
    });
    // The brief already validated the title it chose, so the model's own title is ignored.
    const title = sanitizeText(input.brief.chosenTitle);
    const description = sanitizeText(r.value.description);
    const raw = normalizeDraftMarkdown(sanitizeText(r.value.markdown));
    const evidence = input.evidence.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, sourceId: input.evidenceSources[e.id] ?? "", verified: true }));
    const { markdown, unresolved } = renderCitationsDetailed(
      raw,
      evidence,
      input.sources.map((s) => ({ ...s, markdown: "" })),
      input.citationStyle,
      ctx.run.locale,
    );
    return {
      next: { type: "advance", to: "gates" },
      output: {
        title,
        description,
        markdown: raw,
        citedClaimIds: extractMarkerIds(raw),
        unresolvedMarkers: unresolved,
        words: wordCount(toPlainText(markdown)),
      },
      usage: [{ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd }],
    };
  },
};
