import { marked } from "marked";
import { dropSourcesSection } from "./markdown/plain-text.js";
import type { EvidenceItem, SourceItem } from "./gates/types.js";
import { isBoilerplateTitle, truncate } from "./util.js";

export const CITATION_MARKER_RE = /\{\{c:([A-Za-z0-9_-]+)\}\}/g;
/**
 * A run of markers with the spaces and tabs before it. Never a line break: eating one would join
 * the line above to the one that holds the marker.
 */
const RUN_RE = /(?:[ \t]*\{\{c:[A-Za-z0-9_-]+\}\})+/g;
const LEADING_BLANK_RE = /^[ \t]*/;
const WWW_RE = /^www\./;
const HTTP_URL_RE = /^https?:\/\//i;
/**
 * What would end or bend a link destination, or the text around it: parens, angle brackets, quotes,
 * a backslash, `|` (a table cell ends there), a backtick (it can close a code span that started
 * earlier in the paragraph), any space and any control character.
 */
const UNSAFE_IN_DESTINATION = /[()<>"'`|\\\s\p{Cc}]/gu;
/** What would end or bend a link label (the host): the brackets, and the characters that start emphasis, code or an escape. */
const UNSAFE_IN_LABEL = /[\\`*_[\]]/g;
/** `encodeURIComponent` encodes the rest of what `UNSAFE_IN_DESTINATION` matches, but leaves these three. */
const DESTINATION_ESCAPES: Readonly<Record<string, string>> = {
  "'": "%27",
  "(": "%28",
  ")": "%29",
};
/** An HTML tag with its attributes (quoted values may hold `>`). */
const HTML_TAG_RE = /<\/?[A-Za-z][\w:-]*(?:"[^"]*"|'[^']*'|[^<>"'])*>/g;
/** Tokens whose whole source is a place a link cannot be written: code, and a link's text and target. */
const RAW_TOKEN_TYPES = new Set(["code", "codespan", "def", "image", "link"]);

/** The digits 0 to 9 as superscripts, by digit. */
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** Between two markers of one run: a plain comma, so `¹,³` reads as one mark (every font has it). */
const MARKER_SEPARATOR = ",";
/** The heading of the sources list, per locale; other locales fall back to English until a glossary lands. */
export const SOURCES_HEADINGS: Readonly<Record<string, string>> = {
  en: "Sources",
};
const TITLE_MAX_CHARS = 120;
/** What a source title may not carry into the list: markdown syntax, raw HTML, a stray `{{c:` marker, control characters. */
const FORMAT_CHARS = /\p{Cf}/gu;
const UNSAFE_IN_TITLE = /[\\`*_[\]<>|~{}\p{Cc}]/gu;
const WHITESPACE_RE = /\s+/g;
const LEADING_PUNCTUATION_RE = /^[.,;:!?]/;

export type CitationStyle = "inline" | "references";

const superscript = (n: number): string =>
  [...String(n)].map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d).join("");

export function extractMarkerIds(raw: string): string[] {
  return [...new Set([...raw.matchAll(CITATION_MARKER_RE)].map((m) => m[1] ?? ""))];
}

/**
 * The link destination `renderCitations` writes for a source URL: the URL with what would end or
 * bend a link destination percent-encoded. Null for anything that is not a plain http(s) URL.
 * Source URLs are crawled, so another scheme (`javascript:`, `data:`, ...) is refused.
 */
export function citationDestination(url: string): string | null {
  const text = url.trim();
  if (!(HTTP_URL_RE.test(text) && URL.canParse(text))) {
    return null;
  }
  return text.replace(
    UNSAFE_IN_DESTINATION,
    (c) => DESTINATION_ESCAPES[c] ?? encodeURIComponent(c)
  );
}

/** The URL an evidence row is cited as: where its source ended up after redirects. Empty when the source is unknown. */
export function citedUrl(
  evidence: Pick<EvidenceItem, "sourceId">,
  sources: readonly Pick<SourceItem, "id" | "url" | "finalUrl">[]
): string {
  const source = sources.find((s) => s.id === evidence.sourceId);
  return (source?.finalUrl || source?.url || "").trim();
}

/** The host of an http(s) URL as a link label: no `www.`, and nothing that could bend the link. */
function hostLabel(url: string): string {
  return new URL(url.trim()).hostname
    .replace(WWW_RE, "")
    .replace(UNSAFE_IN_LABEL, (c) => `\\${c}`);
}

/**
 * A source title as it may stand in the list: it comes from a crawled page, so markdown syntax, raw HTML
 * and control characters are dropped, whitespace is collapsed and the length is capped. Empty when nothing
 * usable is left.
 */
function cleanTitle(title: string | null | undefined): string {
  const text = (title ?? "")
    // Bidi overrides, zero-width and other format (Cf) characters can reorder or hide the text: dropped.
    .replace(FORMAT_CHARS, "")
    .replace(UNSAFE_IN_TITLE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();
  // A crawl can store a cookie banner or a nav label as the title: the host-only label stands in for it.
  return isBoilerplateTitle(text) ? "" : truncate(text, TITLE_MAX_CHARS);
}

/** The parts of a lexed token that say where a marker sits. */
interface LexToken {
  header?: LexToken[] | boolean;
  items?: LexToken[];
  raw?: string;
  rows?: LexToken[][];
  tokens?: LexToken[];
  type?: string;
}

function childrenOf(token: LexToken): LexToken[] {
  return [
    ...(token.tokens ?? []),
    ...(token.items ?? []),
    ...(Array.isArray(token.header) ? token.header : []),
    ...(token.rows ?? []).flat(),
  ];
}

/** The text of a token in which a link cannot be written, or "" when the token is prose. */
function nonProseText(token: LexToken): string {
  if (RAW_TOKEN_TYPES.has(token.type ?? "")) {
    return token.raw ?? "";
  }
  if (token.type === "html") {
    return (token.raw ?? "").match(HTML_TAG_RE)?.join(" ") ?? "";
  }
  return "";
}

function visitTokens(tokens: LexToken[], seen: (text: string) => void): void {
  for (const token of tokens) {
    seen(nonProseText(token));
    if (!RAW_TOKEN_TYPES.has(token.type ?? "")) {
      visitTokens(childrenOf(token), seen);
    }
  }
}

/**
 * The runs (by position in `runs`) that sit where a link cannot be written: inside an inline code
 * span, a fenced or indented code block, a markdown link's text or target, or an HTML attribute.
 * Each run is swapped for a one-word stand-in and the text is read with `marked`'s lexer, so what
 * counts as code or as a link is what the page does.
 */
function runsInNonProse(raw: string, runs: RegExpMatchArray[]): Set<number> {
  let prefix = "citeslot";
  while (raw.toLowerCase().includes(prefix)) {
    prefix += "x";
  }
  let masked = "";
  let cursor = 0;
  for (const [i, run] of runs.entries()) {
    const at = run.index ?? 0;
    const lead = LEADING_BLANK_RE.exec(run[0])?.[0] ?? "";
    masked += `${raw.slice(cursor, at)}${lead}${prefix}${i}z`;
    cursor = at + run[0].length;
  }
  masked += raw.slice(cursor);
  const standIn = new RegExp(`${prefix}(\\d+)z`, "g");
  const found = new Set<number>();
  visitTokens(marked.lexer(masked) as unknown as LexToken[], (text) => {
    for (const m of text.matchAll(standIn)) {
      found.add(Number(m[1]));
    }
  });
  return found;
}

/** An evidence row with the URL its source is cited as. */
interface EvidenceLink {
  id: string;
  sourceId: string;
  url: string;
  verified: boolean;
}
type EvidenceLinks = Map<string, EvidenceLink>;

/** One cited source: its number in the post, where it lives and what its page is called. */
interface NumberedSource {
  destination: string;
  host: string;
  n: number;
  title: string;
}

/** The distinct linkable URLs of a run's ids (with the row each came from), and the ids that cannot be linked. */
function resolveRun(
  ids: string[],
  byId: EvidenceLinks
): { bad: string[]; found: Map<string, EvidenceLink> } {
  const found = new Map<string, EvidenceLink>();
  const bad: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const destination = row?.verified ? citationDestination(row.url) : null;
    if (row === undefined || destination === null) {
      bad.push(id);
    } else if (!found.has(destination)) {
      found.set(destination, row);
    }
  }
  return { bad, found };
}

/** Hands out the post's source numbers, by first appearance of a URL. */
function createNumbering(sources: readonly Pick<SourceItem, "id" | "title">[]) {
  const titles = new Map(sources.map((s) => [s.id, cleanTitle(s.title)]));
  const numbered = new Map<string, NumberedSource>();
  return {
    all: () => [...numbered.values()],
    take(row: EvidenceLink, destination: string): NumberedSource {
      const title = titles.get(row.sourceId) ?? "";
      const known = numbered.get(destination);
      if (known) {
        known.title ||= title;
        return known;
      }
      const added: NumberedSource = {
        destination,
        host: hostLabel(row.url),
        n: numbered.size + 1,
        title,
      };
      numbered.set(destination, added);
      return added;
    },
  };
}

/** The links of one run: superscripts by number (`[¹](url),[³](url)`), or the host (`[host](url)`) inline. */
function markerText(sources: NumberedSource[], style: CitationStyle): string {
  const sorted = [...sources].sort((a, b) => a.n - b.n);
  return style === "inline"
    ? sorted.map((s) => `[${s.host}](${s.destination})`).join(", ")
    : sorted
        .map((s) => `[${superscript(s.n)}](${s.destination})`)
        .join(MARKER_SEPARATOR);
}

/** `N. [title](url) — host` for each source, in number order. */
function sourcesList(sources: NumberedSource[]): string {
  return sources
    .map((s) => {
      const label = s.title || s.host;
      const tail = s.title ? ` — ${s.host}` : "";
      return `${s.n}. [${label}](${s.destination})${tail}`;
    })
    .join("\n");
}

/**
 * What replaces a run of markers, and how many characters after it are used up. At the start of a line
 * the indentation stays. A marker written before the closing punctuation goes behind it: `text.¹`, not
 * `text¹.`; a spaced run takes no space, so the mark sits right after the word or the punctuation.
 * Inline links are the exception: they follow the sentence after one space.
 */
function place(
  raw: string,
  run: RegExpMatchArray,
  marks: string,
  gap: string
): { eaten: number; text: string } {
  const at = run.index ?? 0;
  if (at === 0 || raw[at - 1] === "\n") {
    return {
      eaten: 0,
      text: `${LEADING_BLANK_RE.exec(run[0])?.[0] ?? ""}${marks}`,
    };
  }
  const end = at + run[0].length;
  const next = raw[end] ?? "";
  const after = raw[end + 1] ?? "";
  return LEADING_PUNCTUATION_RE.test(next) && after !== next && after !== "."
    ? { eaten: 1, text: `${next}${gap}${marks}` }
    : { eaten: 0, text: `${gap}${marks}` };
}

/**
 * Turns each run of `{{c:id}}` markers into links and returns the ids it could not resolve.
 * - `references`: numbered superscript links (`¹`, `²,³`) right after the word or the punctuation, and
 *   one sources list after the body (`N. [title](url) — host`, titles from `sources`, cleaned, else the
 *   host). A sources section already in `markdown` is dropped first, so there is exactly one.
 * - `inline`: `[host](url)` after the sentence, and no list.
 * - Numbers count per post, in order of first appearance; the same URL keeps its number.
 * A run is left exactly as written, and its ids are returned in `unresolved`, so the citations gate fails
 * the draft instead of publishing a half-resolved sentence, when:
 * - it holds an id that is unknown, not verified, or whose source URL is not a safe http(s) link, or
 * - it sits where a link cannot be written (see `runsInNonProse`).
 * A run that starts a line keeps the line's indentation, so a paragraph that continues a list item
 * stays inside it.
 */
export function renderCitationsDetailed(
  input: string,
  evidence: readonly EvidenceItem[],
  sources: readonly SourceItem[],
  style: CitationStyle,
  locale: string
): { markdown: string; unresolved: string[] } {
  const stripped = dropSourcesSection(input);
  const raw = stripped === input ? input : stripped.trimEnd();
  const runs = [...raw.matchAll(RUN_RE)];
  if (runs.length === 0) {
    return { markdown: raw, unresolved: [] };
  }
  const byId: EvidenceLinks = new Map(
    evidence.map((e) => [
      e.id,
      { id: e.id, sourceId: e.sourceId, url: citedUrl(e, sources), verified: e.verified },
    ])
  );
  const numbering = createNumbering(sources);
  const nonProse = runsInNonProse(raw, runs);
  const unresolved = new Set<string>();
  const gap = style === "inline" ? " " : "";
  let markdown = "";
  let cursor = 0;
  for (const [i, run] of runs.entries()) {
    const at = run.index ?? 0;
    const ids = [...run[0].matchAll(CITATION_MARKER_RE)].map((m) => m[1] ?? "");
    const resolved = nonProse.has(i) ? null : resolveRun(ids, byId);
    markdown += raw.slice(cursor, at);
    cursor = at + run[0].length;
    if (resolved === null || resolved.bad.length > 0) {
      for (const id of resolved === null ? ids : resolved.bad) {
        unresolved.add(id);
      }
      markdown += run[0];
      continue;
    }
    // Only a run that renders takes numbers: a run left for the gate must not use one up.
    const marks = markerText(
      [...resolved.found].map(([destination, row]) =>
        numbering.take(row, destination)
      ),
      style
    );
    const placed = place(raw, run, marks, gap);
    markdown += placed.text;
    cursor += placed.eaten;
  }
  markdown += raw.slice(cursor);
  const cited = numbering.all();
  if (style === "references" && cited.length > 0) {
    const heading = SOURCES_HEADINGS[locale] ?? "Sources";
    markdown = `${markdown.trimEnd()}\n\n## ${heading}\n\n${sourcesList(cited)}\n`;
  }
  return { markdown, unresolved: [...unresolved] };
}

export function renderCitations(
  markdown: string,
  evidence: EvidenceItem[],
  sources: SourceItem[],
  style: CitationStyle,
  locale: string
): string {
  return renderCitationsDetailed(markdown, evidence, sources, style, locale).markdown;
}
