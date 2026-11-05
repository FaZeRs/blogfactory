// Vendored from Lindevo packages/mdx/src/lint/plain-text.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { getComponentSpec } from "../component-spec.js";
import { COMMENT_RE, FENCE_RE, INLINE_CODE_RE } from "../../markdown/mask-code.js";
import {
  AUTOLINK_RE,
  normalizeNewlines,
  scanTags,
  type TagEvent,
} from "../lib/tags.js";

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+/;
const BLOCK_PREFIX_RE = /^\s*(?:>+\s*|[-*+]\s+|\d+[.)]\s+)/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const EDGE_PIPE_RE = /^\||\|$/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
/**
 * A run of citation markers the content engine writes: superscript digits, each one the text of a link
 * to the source, with a plain comma between two of them (`[¹](url),[³](url)`).
 */
const CITATION_RUN_RE =
  /\[[⁰¹²³⁴⁵⁶⁷⁸⁹]+\]\([^)]*\)(?:,\[[⁰¹²³⁴⁵⁶⁷⁸⁹]+\]\([^)]*\))*/g;
const SOURCES_HEADING_RE =
  /^ {0,3}##[ \t]+(?:sources|avoti)[ \t]*#*[ \t]*\r?$/i;
/** What ends the sources list: the next heading of level 1 or 2, or the provenance tag. */
const SOURCES_END_RE = /^(?: {0,3}#{1,2}[ \t]|\s*<provenance\b)/;
const EMPHASIS_RE = /(\*\*\*|\*\*|\*|~~)/g;
const MULTI_BLANK_RE = /\n{3,}/g;
// Inline code is swapped for a numbered placeholder while the rest of a line
// is stripped, so nothing inside backticks is ever read as markup.
const HOLD_OPEN = String.fromCharCode(0xe0_00);
const HOLD_CLOSE = String.fromCharCode(0xe0_01);
const HELD_CODE_RE = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g");
// HTML tags that end a line of text, and those that only separate two words.
const LINE_BREAK_TAGS = new Set([
  "blockquote",
  "br",
  "details",
  "hr",
  "li",
  "ol",
  "p",
  "summary",
  "table",
  "tr",
  "ul",
]);
const CELL_TAGS = new Set(["td", "th"]);

function caseStatText(attrs: Map<string, string | true>): string {
  const read = (key: string) => {
    const value = attrs.get(key);
    return typeof value === "string" ? value : "";
  };
  const [label, before, after, value, change] = [
    "label",
    "before",
    "after",
    "value",
    "change",
  ].map(read);
  const pair = before && after ? `${before} → ${after}` : "";
  const figure = pair || value || change;
  const chip = pair && change ? ` (${change})` : "";
  const head = label && figure ? `${label}: ` : label;
  return `\n${head}${figure}${chip}\n`;
}

function tagText(tag: TagEvent): string {
  const spec = getComponentSpec(tag.name);
  if (!spec) {
    if (LINE_BREAK_TAGS.has(tag.name)) {
      return "\n";
    }
    return CELL_TAGS.has(tag.name) ? " " : "";
  }
  if (tag.closing) {
    return "\n";
  }
  if (spec.tag === "case-stat") {
    return caseStatText(tag.attrs);
  }
  const title = tag.attrs.get("title");
  return typeof title === "string" &&
    (spec.tag.startsWith("workflow") || spec.tag.startsWith("tour"))
    ? `\n${title}\n`
    : "\n";
}

/**
 * Drops comments and fenced code the way the renderer finds them: a fence ends
 * at a marker of the same character, at least as long, and an unclosed fence
 * runs to the end of the article.
 */
function dropCode(markdown: string): string {
  let fence: string | null = null;
  const kept: string[] = [];
  for (const line of markdown.replace(COMMENT_RE, "").split("\n")) {
    const marker = line.match(FENCE_RE)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Per line: true when it is a fence line or sits inside fenced code. */
function codeLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const marker = line.match(FENCE_RE)?.[1];
    if (fence === null) {
      fence = marker ?? null;
      return marker !== undefined;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
    return true;
  });
}

/** Which lines sit in a `## Sources` (or `## Avoti`) section, heading included. Fenced code is left alone. */
function sourcesLines(lines: string[]): boolean[] {
  const code = codeLines(lines);
  let skipping = false;
  return lines.map((line, i) => {
    if (code[i]) {
      return skipping;
    }
    if (skipping && SOURCES_END_RE.test(line)) {
      skipping = false;
    }
    if (!skipping && SOURCES_HEADING_RE.test(line)) {
      skipping = true;
    }
    return skipping;
  });
}

/**
 * The text without its `## Sources` (or `## Avoti`) section: from that heading to the next level-1 or
 * level-2 heading or the provenance tag, whichever comes first. Fenced code is left alone.
 */
export function dropSourcesSection(markdown: string): string {
  const lines = markdown.split("\n");
  const inSources = sourcesLines(lines);
  return lines.filter((_, i) => !inSources[i]).join("\n");
}

const SOURCES_ITEM_RE = /^\s*\d+[.)]\s+/;
const SOURCES_HEADING_TEXT_RE = /^ {0,3}##[ \t]+|[ \t]*#*[ \t]*\r?$/g;

export interface SourcesSection {
  /** The count of numbered list items. */
  count: number;
  /** The section's own heading text ("Sources" or "Avoti"), so the label follows the content language. */
  heading: string;
  /** The section without its heading line: the numbered list. */
  markdown: string;
}

/**
 * The article split into its body and its sources section, by the same rule as `dropSourcesSection`:
 * `body` is exactly what that returns.
 */
export function splitSourcesSection(markdown: string): {
  body: string;
  sources: SourcesSection | null;
} {
  const lines = markdown.split("\n");
  const inSources = sourcesLines(lines);
  const code = codeLines(lines);
  const section: string[] = [];
  let heading = "";
  let count = 0;
  lines.forEach((line, i) => {
    if (!inSources[i]) {
      return;
    }
    if (!(code[i] || heading) && SOURCES_HEADING_RE.test(line)) {
      heading = line.replace(SOURCES_HEADING_TEXT_RE, "");
      return;
    }
    if (!code[i] && SOURCES_ITEM_RE.test(line)) {
      count += 1;
    }
    section.push(line);
  });
  const body = lines.filter((_, i) => !inSources[i]).join("\n");
  if (!heading) {
    return { body, sources: null };
  }
  return {
    body,
    sources: { count, heading, markdown: section.join("\n").trim() },
  };
}

function replaceTags(prose: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const tag of scanTags(prose)) {
    parts.push(prose.slice(last, tag.index), tagText(tag));
    last = tag.end;
  }
  parts.push(prose.slice(last));
  return parts.join("");
}

/** A table's `| --- | :-: |` row, which carries no text. */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.includes("-") &&
    trimmed
      .replace(EDGE_PIPE_RE, "")
      .split("|")
      .every((cell) => SEPARATOR_CELL_RE.test(cell.trim()))
  );
}

function stripMarkup(text: string): string {
  return text
    .replace(HEADING_RE, "")
    .replace(BLOCK_PREFIX_RE, "")
    .replace(IMAGE_RE, "")
    .replace(CITATION_RUN_RE, "")
    .replace(LINK_RE, "$1")
    .replace(AUTOLINK_RE, "$1")
    .replace(EMPHASIS_RE, "")
    .split("|")
    .map((cell) => cell.trim())
    .join(" ")
    .trim();
}

function plainLine(line: string): string {
  const code: string[] = [];
  const held = line.replace(INLINE_CODE_RE, (match: string, ticks: string) => {
    code.push(match.slice(ticks.length, -ticks.length));
    return `${HOLD_OPEN}${code.length - 1}${HOLD_CLOSE}`;
  });
  return stripMarkup(held).replace(
    HELD_CODE_RE,
    (_match, index: string) => code[Number(index)] ?? ""
  );
}

/** Article markdown as the prose a reader sees: no code, tags or markup. */
export function stripToPlainText(markdown: string): string {
  return replaceTags(dropSourcesSection(dropCode(normalizeNewlines(markdown))))
    .split("\n")
    .filter((line) => !isTableSeparator(line))
    .map(plainLine)
    .join("\n")
    .replace(MULTI_BLANK_RE, "\n\n")
    .trim();
}
