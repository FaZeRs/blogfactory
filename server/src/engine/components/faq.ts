// Vendored from Lindevo packages/mdx/src/faq.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { headingText } from "./lib/heading.js";
import { COMMENT_RE } from "./lib/mask-code.js";

/**
 * Extracts the question/answer pairs an article actually renders, so FAQPage
 * markup can only ever describe content a visitor can see. Moved here from
 * apps/web/src/lib/blog-faq.ts so the linter and the content engine read FAQs
 * exactly the way the site does.
 *
 * Expected shape:
 *
 * ```markdown
 * ## Frequently Asked Questions
 * ### A real question?
 * The answer, one or more paragraphs.
 * ## Some other section   <- ends the FAQ block
 * ```
 *
 * Anything that does not match is skipped rather than guessed at: no FAQ
 * section, no headings ending in a question mark, or a short answer all yield
 * nothing, which callers must treat as "emit no FAQPage node".
 */

/** Heading text that opens an FAQ block, in the locales the site publishes. */
const FAQ_TITLES =
  "(?:frequently\\s+asked\\s+questions|faqs?|common\\s+questions|questions?\\s*(?:&|and)\\s*answers|biežāk\\s+uzdotie\\s+jautājumi|bieži\\s+uzdotie\\s+jautājumi|buj)\\b";

const FAQ_TITLE_RE = new RegExp(`^${FAQ_TITLES}`, "i");

/** A whole `##` heading line that opens an FAQ block, e.g. "## FAQ". */
export const FAQ_HEADING_RE = new RegExp(`^##\\s+${FAQ_TITLES}`, "i");

const TOP_HEADING_RE = /^#\s+/;

// The `g` ones are only ever used with `replace`, so they keep no state.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const EMPHASIS_RE = /(\*\*\*|\*\*|\*|__|_|~~)/g;
const CODE_SPAN_RE = /`([^`]*)`/g;
const JSX_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const BLOCK_PREFIX_RE = /^\s*(?:>+\s*|[-*+]\s+|\d+[.)]\s+)/;
const WHITESPACE_RE = /\s+/;
const ANSWER_FENCE_RE = /^\s*(?:```|~~~)/;
const TABLE_ROW_RE = /^\s*\|/;
const LINE_BREAK_RE = /\r?\n/;

/** The shortest answer we are willing to publish as an `acceptedAnswer`. */
export const MIN_FAQ_ANSWER_LENGTH = 40;
const MIN_QUESTION_LENGTH = 8;

export interface FaqEntry {
  answer: string;
  /** The heading reads as a question (ends with "?"). */
  isQuestion: boolean;
  /** 1-based line of the `###` heading. */
  line: number;
  question: string;
}

function stripInline(line: string): string {
  return line
    .replace(COMMENT_RE, "")
    .replace(MARKDOWN_IMAGE_RE, "")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(CODE_SPAN_RE, "$1")
    .replace(JSX_TAG_RE, "")
    .replace(EMPHASIS_RE, "")
    .trim();
}

/**
 * Flattens the markdown body of one answer into plain sentences. Tables,
 * fenced code and component wrappers are dropped because they do not read as
 * an answer.
 */
function toAnswerText(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length > 0) {
      paragraphs.push(current.join(" ").replace(WHITESPACE_RE, " ").trim());
      current = [];
    }
  };

  for (const raw of lines) {
    if (ANSWER_FENCE_RE.test(raw)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence || TABLE_ROW_RE.test(raw)) {
      continue;
    }
    if (raw.trim() === "") {
      flush();
      continue;
    }
    const deeper = headingText(raw, 4, 6);
    const body = deeper ?? raw.replace(BLOCK_PREFIX_RE, "");
    const text = stripInline(body);
    if (text !== "") {
      current.push(text);
    }
  }
  flush();

  return paragraphs.filter(Boolean).join("\n\n");
}

/** [start, end) line indexes of the FAQ block, or null when there is none. */
function findFaqSection(lines: string[]): [number, number] | null {
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const heading = headingText(line, 2, 2);
    if (heading === null) {
      continue;
    }
    if (start === -1) {
      if (FAQ_TITLE_RE.test(stripInline(heading))) {
        start = index + 1;
      }
      continue;
    }
    // A sibling `##` closes the FAQ block.
    return [start, index];
  }
  if (start === -1) {
    return null;
  }
  const end = lines.findIndex(
    (line, index) => index >= start && TOP_HEADING_RE.test(line)
  );
  return [start, end === -1 ? lines.length : end];
}

/** Every `###` entry in the FAQ block, question or not, with its line number. */
export function scanFaq(markdown: string): FaqEntry[] {
  const lines = markdown.split(LINE_BREAK_RE);
  const section = findFaqSection(lines);
  if (!section) {
    return [];
  }

  const entries: FaqEntry[] = [];
  let open: { line: number; question: string } | null = null;
  let buffer: string[] = [];

  const commit = () => {
    if (open) {
      entries.push({
        answer: toAnswerText(buffer),
        isQuestion: open.question.endsWith("?"),
        line: open.line,
        question: open.question,
      });
    }
    open = null;
    buffer = [];
  };

  const [start, end] = section;
  for (const [offset, line] of lines.slice(start, end).entries()) {
    const heading = headingText(line, 3, 3);
    if (heading !== null) {
      commit();
      open = {
        line: start + offset + 1,
        question: stripInline(heading),
      };
      continue;
    }
    if (open) {
      buffer.push(line);
    }
  }
  commit();

  return entries;
}

/** The pairs safe to publish as FAQPage markup. */
export function extractFaq(
  markdown: string
): { question: string; answer: string }[] {
  return scanFaq(markdown)
    .filter(
      (entry) =>
        entry.isQuestion &&
        entry.question.length >= MIN_QUESTION_LENGTH &&
        entry.answer.length >= MIN_FAQ_ANSWER_LENGTH
    )
    .map(({ answer, question }) => ({ answer, question }));
}
