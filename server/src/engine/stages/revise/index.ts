import { ENGINE_CONFIG } from "../../config.js";
import { MIN_FAQ_ANSWER_LENGTH } from "../../markdown/faq.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage } from "../../runtime/stage.js";
import { StageInputError } from "../../types.js";
import { sanitizeText } from "../../util.js";
import { componentVars, loadWriterContext, toDraftOutput, type DraftInput } from "../draft/index.js";
import { DraftSchema, type DraftOutput } from "../draft/schema.js";
import type { GatesOutput } from "../gates/schema.js";
import { evidenceText, findStageOutput, latestDraft, linksText, modelFor } from "../shared.js";

export type ReviseInput = DraftInput & { draft: DraftOutput; blockers: GatesOutput["blockers"] };

const fmt = (n: number) => n.toLocaleString("en-US");

/** The length instruction comes first in the prompt, so fixing one problem cannot create a length failure. */
export function lengthInstruction(words: number): string {
  const { minWords, maxWords, targetWords } = ENGINE_CONFIG.gates;
  const counted = `It has ${fmt(words)} words, counted on the text a reader sees (citation marks and the Sources list included).`;
  if (words > maxWords) {
    return `FIRST PRIORITY: the article is too long. ${counted} The hard limit is ${fmt(maxWords)}. Cut it to at most ${fmt(targetWords)} words, removing at least ${fmt(words - targetWords)}, and keep every fix inside that limit. Cut whole sentences, repeated points or an extra example; keep the sentences you leave word for word.`;
  }
  if (words < minWords) {
    return `The article is too short. ${counted} The hard minimum is ${fmt(minWords)}. Bring it to at least ${fmt(Math.min(targetWords, minWords + 200))} words with practical guidance on the brief's points, never with a new fact.`;
  }
  return `${counted} Keep it at or under ${fmt(targetWords)} words (the hard limit is ${fmt(maxWords)}): whatever you add, delete as much elsewhere.`;
}

export const reviseStage: Stage<ReviseInput, DraftOutput> = {
  key: "revise",
  promptVersion: await promptVersion("revise"),
  async input({ run }) {
    // The blockers come from whichever of the gates and the review ran last.
    const [context, draft, checked] = await Promise.all([loadWriterContext(run), latestDraft(run), findStageOutput<GatesOutput>(run, "gates", "review")]);
    if (!checked?.output.blockers.length) throw new StageInputError("revise was reached without blockers to fix");
    return { ...context, draft, blockers: checked.output.blockers };
  },
  async run(input, ctx) {
    const g = ENGINE_CONFIG.gates;
    // Excerpts quote the draft, which began as model text over untrusted sources, so the list is data.
    const problems = input.blockers
      .map((b) => `- [${b.gate}] ${sanitizeText(b.message)}${b.excerpt ? `\n    text: "${sanitizeText(b.excerpt)}"` : ""}${b.fix ? `\n    hint: ${sanitizeText(b.fix)}` : ""}`)
      .join("\n");
    const { keywordData: _k, ...brief } = input.brief;
    const prompt = await preparePrompt("revise", {
      dataRule: DATA_RULE,
      ...componentVars(input),
      locale: input.locale,
      voice: input.voice || "No custom voice rules.",
      minWords: g.minWords,
      maxWords: g.maxWords,
      titleMax: g.titleMax,
      descriptionMax: g.descriptionMax,
      faqMinAnswerChars: Math.max(g.faqAnswerMin, MIN_FAQ_ANSWER_LENGTH),
      length: lengthInstruction(input.draft.words),
      blockers: fenceData("problems", problems),
      meta: fenceData("meta", `Title: ${input.draft.title}\nDescription: ${input.draft.description}`),
      draft: fenceData("article", input.draft.markdown),
      brief: fenceData("brief", JSON.stringify(brief, null, 2)),
      evidence: fenceData("evidence", evidenceText(input.evidence)),
      links: linksText(input.brief.internalLinks.map((l) => ({ url: l.url, title: l.anchorText }))),
    });
    const r = await ctx.deps.llm.json({
      role: "revise",
      model: modelFor(ctx.run, "revise"),
      system: prompt.system,
      user: prompt.user,
      schema: DraftSchema,
      maxTokens: 12_000,
      signal: ctx.signal,
    });
    // The runtime raises revise_count when this stage advances; the title stays the brief's.
    return {
      next: { type: "advance", to: "gates" },
      output: toDraftOutput(input, ctx.run.locale, { title: input.draft.title, description: r.value.description, markdown: r.value.markdown }),
      usage: [{ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd }],
    };
  },
};
