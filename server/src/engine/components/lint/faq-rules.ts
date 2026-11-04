// Vendored from Lindevo packages/mdx/src/lint/faq-rules.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { MIN_FAQ_ANSWER_LENGTH, scanFaq } from "../faq.js";
import { issueAt, type RawIssue } from "./issue.js";

/** Every FAQ entry must be a question with an answer worth publishing. */
export function lintFaq(markdown: string): RawIssue[] {
  return scanFaq(markdown).flatMap((entry) => {
    const at = { col: 1, line: entry.line };
    if (!entry.isQuestion) {
      return [
        issueAt(
          at,
          "faq-question-mark",
          `FAQ heading "${entry.question}" is not a question.`,
          'End it with "?".'
        ),
      ];
    }
    if (entry.answer.length < MIN_FAQ_ANSWER_LENGTH) {
      return [
        issueAt(
          at,
          "faq-answer-too-short",
          `The answer to "${entry.question}" has ${entry.answer.length} characters; FAQ answers need at least ${MIN_FAQ_ANSWER_LENGTH}.`
        ),
      ];
    }
    return [];
  });
}
