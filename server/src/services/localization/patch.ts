import { sanitizeText } from "../../engine/util.js";
import { GROWTH_SLACK, MAX_GROWTH, type FixField } from "./schema.js";

/** A review issue as the patch reads it: the quoted translated text and the reviewer's corrected wording. */
export interface ReviewFix {
  excerpt: string;
  field?: FixField;
  fix: string;
}

export interface PatchableText {
  title: string;
  description: string;
  markdown: string;
}

/**
 * What a patch never touches, in the markdown: fenced code (to its closing fence, or the end when it
 * has none), inline code, a `{{…}}` marker, a superscript citation link, a link or image destination,
 * a link reference definition, an autolink or bare URL, an HTML comment, and a component or HTML tag
 * with its attributes (quoted values may hold `>`).
 */
const PROTECTED_RES: readonly RegExp[] = [
  /(```|~~~)[\s\S]*?(?:\1|$)/g,
  /`[^`\n]*`/g,
  /\{\{[\s\S]*?(?:\}\}|$)/g,
  /\[[⁰¹²³⁴⁵⁶⁷⁸⁹]+\]\([^)]*\)/g,
  /\]\((?:[^()\n]|\([^()\n]*\))*\)/g,
  /^[ \t]*\[[^\]\n]+\]:[^\n]*/gm,
  /<[a-z][a-z0-9+.-]*:[^<>\s]*>/gi,
  /\bhttps?:\/\/[^\s<>()]+/gi,
  /<!--[\s\S]*?(?:-->|$)/g,
  /<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^<>"'])*>/g,
];
/** The characters that make markdown structure, plus the superscript digits of a citation mark. */
const MARKUP_RE = /[*_`[\]()<>{}#|~\\⁰¹²³⁴⁵⁶⁷⁸⁹]/g;
const LINE_BREAK_RE = /[\r\n]/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const LEAD_CUT_RE = /^(?:…|\.\.\.)\s*/;
const TRAIL_CUT_RE = /\s*(?:…|\.\.\.)$/;

/** As the model's text is cleaned: no NUL, no lone surrogate, composed (NFC), and trimmed. */
const clean = (text: string) => sanitizeText(text).normalize("NFC").trim();

const markup = (text: string) => (text.match(MARKUP_RE) ?? []).join("");

const isWordChar = (c: string | undefined) => c !== undefined && WORD_CHAR_RE.test(c);

/**
 * A `…` (or `...`) the reviewer put at an end of both texts marks where it cut the quote, so it is
 * dropped from both. At an end of only one of them the two texts do not line up, and nothing is patched.
 */
function stripCut(excerpt: string, fix: string): ReviewFix | null {
  if (LEAD_CUT_RE.test(excerpt) !== LEAD_CUT_RE.test(fix) || TRAIL_CUT_RE.test(excerpt) !== TRAIL_CUT_RE.test(fix)) return null;
  const strip = (s: string) => s.replace(LEAD_CUT_RE, "").replace(TRAIL_CUT_RE, "");
  return { excerpt: strip(excerpt), fix: strip(fix) };
}

/**
 * The quote and the fix, when the fix can stand in for the quote as it is: both non-empty and
 * different, on one line, with the same markdown characters (a fix may change words, never a link,
 * a mark, emphasis or a tag), and not much longer than the quote.
 */
function usable(issue: ReviewFix): ReviewFix | null {
  const cut = stripCut(clean(issue.excerpt), clean(issue.fix));
  if (!cut) return null;
  const { excerpt, fix } = cut;
  const ok =
    excerpt !== "" &&
    fix !== "" &&
    excerpt !== fix &&
    !LINE_BREAK_RE.test(excerpt) &&
    !LINE_BREAK_RE.test(fix) &&
    markup(excerpt) === markup(fix) &&
    fix.length <= excerpt.length * MAX_GROWTH + GROWTH_SLACK;
  return ok ? cut : null;
}

function occurrences(text: string, part: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + 1)) at.push(i);
  return at;
}

/** The quote at `at` neither starts nor ends inside a longer word. */
function onWordEdges(text: string, at: number, part: string): boolean {
  return !((isWordChar(part[0]) && isWordChar(text[at - 1])) || (isWordChar(part.at(-1)) && isWordChar(text[at + part.length])));
}

const splice = (text: string, at: number, length: number, insert: string) => `${text.slice(0, at)}${insert}${text.slice(at + length)}`;

function protectedSpans(markdown: string): [number, number][] {
  return PROTECTED_RES.flatMap((re) => [...markdown.matchAll(re)].map((m): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length]));
}

/** Where the quote stands in the text: its one place, on word edges and clear of every protected span. */
function site(text: string, excerpt: string): number | null {
  const sites = occurrences(text, excerpt);
  const [at] = sites;
  if (sites.length !== 1 || at === undefined || !onWordEdges(text, at, excerpt)) return null;
  const end = at + excerpt.length;
  return protectedSpans(text).some(([s, e]) => at < e && s < end) ? null : at;
}

/** The field limits a corrected title or description must still meet (the model's own schema limits). */
const FIELD_OK: Record<Exclude<FixField, "markdown">, (v: string) => boolean> = {
  title: (v) => v.length >= 3 && v.length <= 200,
  description: (v) => v.length <= 500,
};

/** Inflection depends on context: apply a correction only to the field the reviewer quoted. */
function applyFix<T extends PatchableText>(tr: T, issue: ReviewFix): T | null {
  const pair = usable(issue);
  if (!pair) return null;
  const field = issue.field ?? "markdown";
  const text = tr[field];
  const at = site(text, pair.excerpt);
  if (at === null) return null;
  const corrected = splice(text, at, pair.excerpt.length, pair.fix);
  if (field !== "markdown" && !FIELD_OK[field](corrected)) return null;
  return { ...tr, [field]: corrected };
}

/**
 * The reviewer's own corrections applied in code, before any model is asked to revise. The reviewer
 * reads the fields as they are, so its quote is matched verbatim. A fix is applied only where the quote
 * stands exactly once, on word edges and outside code, `{{…}}` markers, citation marks, link targets,
 * URLs and tags. A finding without a field is a markdown finding. Anything else (a quote found twice or
 * not at all, one inside a link or a tag, advice instead of a wording) is left for the model's revision.
 * The fixes are applied in order, each to the text the one before left. Null when none applied.
 */
export function patchTranslation<T extends PatchableText>(tr: T, issues: readonly ReviewFix[]): { text: T; patched: number } | null {
  let out = tr;
  let patched = 0;
  for (const issue of issues) {
    const next = applyFix(out, issue);
    if (next) {
      out = next;
      patched += 1;
    }
  }
  return patched > 0 ? { text: out, patched } : null;
}
