// Vendored from Lindevo packages/mdx/src/lib/tags.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { blankOut, maskCode } from "../../markdown/mask-code.js";

export interface TagEvent {
  /** The attribute text between the tag name and ">", as written. */
  attrSource: string;
  attrs: Map<string, string | true>;
  closing: boolean;
  /** 1-based column of "<". */
  col: number;
  /** Index just past ">". */
  end: number;
  /** Index of "<". */
  index: number;
  /** 1-based line of "<". */
  line: number;
  /** Lowercased, the way HTML parsers see it. */
  name: string;
  /** As written. */
  rawName: string;
  selfClosing: boolean;
}

type QuoteStyle = "double" | "single" | "bare" | "none";

interface ParsedAttr {
  name: string;
  quote: QuoteStyle;
  value: string | true;
}

// The `g` regexes below keep `lastIndex` state: they are only ever used with
// `matchAll` and `replace`, never with `exec` or `test`.
//
// The name must be followed by whitespace, "/" or ">" (the way CommonMark ends
// a tag name). Without that look-ahead the name and the attribute text can
// split at any point, and a long run of text after a stray "<" backtracks
// quadratically.
const TAG_RE =
  /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^<>"'/])*)(\/?)>/g;
// Unlike the renderer's container ATTR_RE this also reads single-quoted and
// unquoted values, so the linter can say what the renderer would not.
const TAG_ATTR_RE =
  /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NEWLINE_RE = /\n/g;
const LINE_ENDING_RE = /\r\n?/g;
/** Group 1 is the address, so a plain-text pass can keep it. */
export const AUTOLINK_RE =
  /<((?:https?|mailto|ftp):[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/g;

function readAttr(
  name: string,
  double: string | undefined,
  single: string | undefined,
  bare: string | undefined
): ParsedAttr {
  if (double !== undefined) {
    return { name, quote: "double", value: double };
  }
  if (single !== undefined) {
    return { name, quote: "single", value: single };
  }
  if (bare !== undefined) {
    return { name, quote: "bare", value: bare };
  }
  return { name, quote: "none", value: true };
}

function parseAttrs(source: string): ParsedAttr[] {
  return [...source.matchAll(TAG_ATTR_RE)].flatMap(
    ([, name, double, single, bare]) =>
      name ? [readAttr(name, double, single, bare)] : []
  );
}

/** Attribute values by name. As in HTML, the first of a repeated name wins. */
export function parseTagAttrs(source: string): Map<string, string | true> {
  const attrs = new Map<string, string | true>();
  for (const { name, value } of parseAttrs(source)) {
    if (!attrs.has(name)) {
      attrs.set(name, value);
    }
  }
  return attrs;
}

/**
 * Names of the attributes written without double quotes. The renderer reads
 * container tags with double quotes only.
 */
export function notDoubleQuoted(source: string): string[] {
  return parseAttrs(source)
    .filter(({ quote }) => quote === "single" || quote === "bare")
    .map(({ name }) => name);
}

/**
 * "\r\n" and "\r" become "\n", as marked does before it reads anything, so the
 * linter sees the same lines the renderer does.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(LINE_ENDING_RE, "\n");
}

/** Index of the first character of every line. */
export function lineStarts(src: string): number[] {
  return [
    0,
    ...[...src.matchAll(NEWLINE_RE)].map((match) => (match.index ?? 0) + 1),
  ];
}

/** 1-based line and column of a string index. */
export function positionOf(
  starts: number[],
  index: number
): { col: number; line: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { col: index - (starts[low] ?? 0) + 1, line: low + 1 };
}

/** Code, comments and autolinks blanked out; indexes unchanged. */
export function maskForScan(markdown: string): string {
  return maskCode(markdown).replace(AUTOLINK_RE, blankOut);
}

/** Every HTML-like tag outside code, in document order. */
export function scanTags(markdown: string): TagEvent[] {
  const masked = maskForScan(markdown);
  const starts = lineStarts(masked);
  const events: TagEvent[] = [];
  for (const match of masked.matchAll(TAG_RE)) {
    const index = match.index ?? 0;
    const rawName = match[2] ?? "";
    const end = index + match[0].length;
    // Attributes are read from the original text: masking only exists to find
    // the tag, and must not blank a backtick-quoted word inside a value.
    const attrStart = index + 1 + (match[1]?.length ?? 0) + rawName.length;
    const attrSource = markdown.slice(
      attrStart,
      end - 1 - (match[4]?.length ?? 0)
    );
    events.push({
      attrSource,
      attrs: parseTagAttrs(attrSource),
      closing: match[1] === "/",
      end,
      index,
      name: rawName.toLowerCase(),
      rawName,
      selfClosing: match[4] === "/",
      ...positionOf(starts, index),
    });
  }
  return events;
}
