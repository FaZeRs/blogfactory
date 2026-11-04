import type { EngineConfig } from "../config.js";
import { extractFaq, scanFaq } from "../markdown/faq.js";
import { toPlainText } from "../markdown/plain-text.js";
import { wordCount } from "../util.js";
import { type GateIssue, type GateResult, gateResult } from "./types.js";

const FAQ_MIN_ITEMS = 3;

/** Length limits for the article, its title and its description. */
export function metaGate(
  input: { markdown: string; title: string; description: string },
  cfg: EngineConfig["gates"]
): GateResult {
  const words = wordCount(toPlainText(input.markdown));
  const issues: GateIssue[] = [];
  if (words < cfg.minWords || words > cfg.maxWords) {
    issues.push({
      message: `article has ${words} words; allowed ${cfg.minWords}–${cfg.maxWords}`,
    });
  }
  if (input.title.length > cfg.titleMax) {
    issues.push({
      excerpt: input.title,
      message: `title is ${input.title.length} characters; allowed up to ${cfg.titleMax}`,
    });
  }
  if (input.description.length > cfg.descriptionMax) {
    issues.push({
      excerpt: input.description,
      message: `description is ${input.description.length} characters; allowed up to ${cfg.descriptionMax}`,
    });
  }
  return gateResult("meta", issues, "blocker", { words });
}

/**
 * The FAQ: enough usable questions (`extractFaq` is what a page publishes as FAQPage markup),
 * every heading a question, every answer long enough.
 */
export function faqGate(
  markdown: string,
  cfg: EngineConfig["gates"]
): GateResult {
  const usable = extractFaq(markdown);
  const issues: GateIssue[] = [];
  if (usable.length < FAQ_MIN_ITEMS) {
    issues.push({
      message: `FAQ has ${usable.length} usable questions; needs at least ${FAQ_MIN_ITEMS}`,
    });
  }
  for (const entry of scanFaq(markdown)) {
    if (!entry.question.trim().endsWith("?")) {
      issues.push({
        excerpt: entry.question,
        message: "FAQ question must end with ?",
      });
    }
    if (entry.answer.length < cfg.faqAnswerMin) {
      issues.push({
        excerpt: entry.question,
        message: `FAQ answer is ${entry.answer.length} characters; needs at least ${cfg.faqAnswerMin}`,
      });
    }
  }
  return gateResult("faq", issues, "blocker", { items: usable.length });
}
