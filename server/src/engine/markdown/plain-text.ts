import {
  blankOut,
  COMMENT_RE,
  FENCE_RE,
  INLINE_CODE_RE,
  maskCode,
} from "./mask-code.js";

// The name must be followed by whitespace, "/" or ">" so a stray "<" cannot backtrack quadratically.
const TAG_RE =
  /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^<>"'/])*\/?>/g;
const AUTOLINK_RE =
  /<((?:https?|mailto|ftp):[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/g;
const LINE_ENDING_RE = /\r\n?/g;

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

/** Every HTML-like tag is markup, not text: line-level ones break the line, cells separate words. */
function tagText(name: string): string {
  if (LINE_BREAK_TAGS.has(name)) {
    return "\n";
  }
  return CELL_TAGS.has(name) ? " " : "";
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

function replaceTags(prose: string): string {
  // Tags are found in a copy with code, comments and autolinks blanked; indexes are unchanged.
  const masked = maskCode(prose).replace(AUTOLINK_RE, blankOut);
  const parts: string[] = [];
  let last = 0;
  for (const tag of masked.matchAll(TAG_RE)) {
    const index = tag.index ?? 0;
    parts.push(prose.slice(last, index), tagText((tag[1] ?? "").toLowerCase()));
    last = index + tag[0].length;
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
export function toPlainText(markdown: string): string {
  return replaceTags(
    dropSourcesSection(dropCode(markdown.replace(LINE_ENDING_RE, "\n")))
  )
    .split("\n")
    .filter((line) => !isTableSeparator(line))
    .map(plainLine)
    .join("\n")
    .replace(MULTI_BLANK_RE, "\n\n")
    .trim();
}
