import { serviceCtaTag, writerComponents } from "../../components/guide.js";
import { ENGINE_CONFIG } from "../../config.js";
import { componentProfile, type ComponentProfile } from "../../profile.js";
import { extractMarkerIds, renderCitationsDetailed } from "../../citations.js";
import { toPlainText } from "../../markdown/plain-text.js";
import { MODE_PRESETS } from "../../modes.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { ArticleRunRow, Stage } from "../../runtime/stage.js";
import { StageInputError, type EngineMode } from "../../types.js";
import { sanitizeText, wordCount } from "../../util.js";
import { MIN_FAQ_ANSWER_LENGTH } from "../../markdown/faq.js";
import { getEffectiveSettings } from "../../../services/user-settings.js";
import { PLAN, BriefOutputSchema, fitDescription, type BriefOutput } from "../brief/schema.js";
import { evidenceText, latestStageOutput, linksText, loadEvidence, loadSources, modelFor, normalizeDraftMarkdown, runSettings, writerVoice, type PromptEvidence } from "../shared.js";
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
  /** The component profile frozen at run start; missing means "markdown". */
  profile?: ComponentProfile;
};

/** The exact call-to-action tag the brief chose, or "" for the markdown profile and a "none" service. */
export function ctaTagFor(input: Pick<DraftInput, "brief" | "profile">): string {
  const { service, painPoint } = input.brief;
  return input.profile === "lindevo" && service && service !== "none" ? serviceCtaTag(service, painPoint) : "";
}

/** The draft and revise prompt variables for components: the guide with its placement rules, and the CTA line. */
export function componentVars(input: Pick<DraftInput, "brief" | "profile">) {
  const cta = ctaTagFor(input);
  return {
    components: writerComponents(input.profile === "lindevo", cta !== ""),
    serviceCta: cta ? `Before the FAQ, put exactly one call to action on its own line with a blank line before and after it, written exactly as:\n${cta}` : "",
  };
}

/** The brief as the writer reads it: the keyword lookup is code data, not part of the plan. */
const briefForPrompt = ({ keywordData: _k, ...brief }: BriefOutput) => JSON.stringify(brief, null, 2);

/** What the writer stages (draft, revise) read: the brief, verified evidence and the sources to cite. */
export async function loadWriterContext(run: ArticleRunRow): Promise<DraftInput> {
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
    voice: writerVoice(settings as never, run.topic),
    brief,
    evidence: verified.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, url: urlOf.get(e.sourceId) ?? "" })),
    sources: sources.map((s) => ({ id: s.id, url: s.url, finalUrl: s.finalUrl, title: s.title })),
    evidenceSources: Object.fromEntries(verified.map((e) => [e.id, e.sourceId])),
    citationStyle: runSettings(run).citationStyle,
    profile: componentProfile(run),
  };
}

/** Normalises the model's article and measures it the way the gates will read it (rendered citations). */
export function toDraftOutput(input: DraftInput, locale: string, parts: { title: string; description: string; markdown: string }): DraftOutput {
  const raw = normalizeDraftMarkdown(sanitizeText(parts.markdown));
  const evidence = input.evidence.map((e) => ({ id: e.id, claim: e.claim, quote: e.quote, sourceId: input.evidenceSources[e.id] ?? "", verified: true }));
  const { markdown, unresolved } = renderCitationsDetailed(raw, evidence, input.sources.map((s) => ({ ...s, markdown: "" })), input.citationStyle, locale);
  return {
    title: sanitizeText(parts.title),
    // Revisions overrun the limit by a few characters; a cut at a word boundary beats another paid round.
    description: fitDescription(sanitizeText(parts.description)),
    markdown: raw,
    citedClaimIds: extractMarkerIds(raw),
    unresolvedMarkers: unresolved,
    words: wordCount(toPlainText(markdown)),
  };
}

export const draftStage: Stage<DraftInput, DraftOutput> = {
  key: "draft",
  promptVersion: await promptVersion("draft"),
  input: ({ run }) => loadWriterContext(run),
  async run(input, ctx) {
    const g = ENGINE_CONFIG.gates;
    const prompt = await preparePrompt("draft", {
      dataRule: DATA_RULE,
      ...componentVars(input),
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
      maxTokens: 20_000,
      signal: ctx.signal,
    });
    // The brief already validated the title it chose, so the model's own title is ignored.
    const output = toDraftOutput(input, ctx.run.locale, { title: input.brief.chosenTitle, description: r.value.description, markdown: r.value.markdown });
    return {
      next: { type: "advance", to: "gates" },
      output,
      usage: [{ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd }],
    };
  },
};
