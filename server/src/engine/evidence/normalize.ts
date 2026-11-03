/**
 * Text normalisation for the quote verifier: both the quote and the crawled page go through
 * `normalizeText`, so what is compared is the words, not the typography or the markup around them.
 *
 * Typographic characters are written as escapes so the source never depends on file encoding:
 *   single quotes  U+2018-U+201B, U+02BC modifier apostrophe, U+2032 prime, U+2039/U+203A guillemets
 *   double quotes  U+201C-U+201F, U+00AB/U+00BB guillemets (Latvian sources use them)
 *   dashes         U+2010-U+2015 (U+2012-U+2015: see GLUED_DASH), U+2212 minus
 *   invisible      U+00AD soft hyphen, U+200B-U+200D zero-width, U+2060 word joiner, U+FEFF BOM
 */

// Footnote references are not part of the sentence: "35%[12]", "35%<sup>1</sup>", "[citation needed]". A bare
// <sup> directly after a digit is an exponent (10<sup>6</sup>), not a footnote, so it stays; a bracketed one
// (<sup>[12]</sup>) is always a footnote. A "[12]" followed by "(" is a link and is left to LINK.
const FOOTNOTE_REF =
  /\[\d{1,3}\](?!\()|\[citation needed\]|(?<!\d)<sup\b[^>]{0,100}>[\s\S]{0,300}?<\/sup>|<sup\b[^>]{0,100}>\s{0,20}\[[\s\S]{0,300}?<\/sup>/gi;

// Every markup run is bounded, so an unterminated `![`, `[` or `<` in a hostile page costs a
// constant per start position instead of a scan to the end of the page.
const IMAGE = /!\[[^\]]{0,300}\]\([^)]{0,2000}\)/g;
const LINK = /\[([^\]]{0,300})\]\([^)]{0,2000}\)/g;
// Only real tag shapes (`<b>`, `</a>`, `<br/>`, `<a href="x">`): "< 5% ... >" is prose and must keep its text.
const HTML_TAG = /<\/?[A-Za-z][\w:-]{0,40}(?:\s[^<>]{0,300})?\/?>/g;
// CommonMark: a backslash before any ASCII punctuation character is an escape ("50\%" is "50%").
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;
// NFKC decomposes the double prime U+2033 into two U+2032 primes: read the pair as one double quote.
const DOUBLE_PRIME = /\u2032\u2032/g;
const SINGLE_QUOTES = /[\u02BC\u2018\u2019\u201A\u201B\u2032\u2039\u203A]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g;
// Dashes (U+2012-U+2015: figure dash, en dash, em dash, horizontal bar), in three cases:
//  - glued between a letter, number, `.` or `%` on the left and a letter or number on the right
//    (2024-2025, 3-5%, result-and written with an en or em dash) it is a hyphen, as a quote typed with a hyphen
//    would have it;
//  - an en dash (U+2013) directly before a digit and not directly after a letter or digit is a minus sign, which
//    LV/EU typography uses (-5 degrees, written with an en dash): it becomes the hyphen-minus the number
//    tokenizer reads as a sign;
//  - any other dash (a spaced one, an em dash before a number) is a dash, never a sign: it becomes a spaced
//    hyphen, so 5% after it is still the number 5%.
// U+2010/U+2011 hyphens and U+2212 minus are hyphen-minus.
const GLUED_DASH = /(?<=[\p{L}\p{N}.%])[\u2012-\u2015](?=[\p{L}\p{N}])/gu;
const EN_DASH_MINUS = /(?<![\p{L}\p{N}])\u2013(?=\d)/gu;
const DASHES = /[\u2012-\u2015]/g;
const HYPHENS = /[\u2010\u2011\u2212]/g;
const INVISIBLES = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// A hyphen at the end of a line, then the rest of the word: "busi-\nnesses". It only fires across a
// newline, so "state-of-the-art" is untouched. Spaces before the newline cannot cross it, which keeps
// the match single-path (no backtracking over a long whitespace run).
const LINE_BREAK_HYPHEN = /(\p{L})[-\u2010][^\S\n]*\n\s*(\p{L})/gu;
const MARKDOWN_PUNCTUATION = /[*_`~#>|]/g;
const WHITESPACE_RUN = /\s+/g;

export function normalizeText(s: string): string {
  return (
    s
      .normalize("NFKC")
      .replace(FOOTNOTE_REF, "")
      .replace(IMAGE, " ")
      .replace(LINK, "$1")
      .replace(HTML_TAG, " ")
      .replace(MARKDOWN_ESCAPE, "$1")
      .replace(DOUBLE_PRIME, '"')
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(INVISIBLES, "")
      // before the dash mapping: only a real hyphen breaks a word across lines, an em dash does not
      .replace(LINE_BREAK_HYPHEN, "$1$2")
      .replace(GLUED_DASH, "-")
      .replace(EN_DASH_MINUS, "-")
      .replace(DASHES, " - ")
      .replace(HYPHENS, "-")
      .replace(MARKDOWN_PUNCTUATION, " ")
      .replace(WHITESPACE_RUN, " ")
      .trim()
      .toLowerCase()
  );
}

// A number token: digits with `.`/`,` between digits, an optional trailing `%`, and a leading `-` when it
// is a sign (not preceded by a letter or digit: "-5%" and "(-3)" are signed, "2020-2025" and "covid-19" are not).
// A space-grouped thousands number ("1 500", "12 345 678": the LV/EU norm) is one number, not "1" and "500"; the
// (?!\d) keeps "5 2025" from reading as "5 202" + "5". NFKC has already turned NBSP and narrow NBSP into plain spaces.
const NUMBER =
  /(?:(?<![\p{L}\p{N}])-)?(?:[1-9]\d{0,2}(?: \d{3})+(?!\d)(?:[.,]\d+)*|\d+(?:[.,]\d+)*)(?:\s?%)?/gu;
const WHITESPACE_CHAR = /\s/g;

export interface NumberToken {
  end: number;
  start: number;
  value: string;
}

/** Number tokens with their offsets; `value` has inner whitespace removed ("42 %" is "42%"). */
export function findNumbers(s: string): NumberToken[] {
  return [...s.matchAll(NUMBER)].map((m) => ({
    end: (m.index ?? 0) + m[0].length,
    start: m.index ?? 0,
    value: m[0].replace(WHITESPACE_CHAR, ""),
  }));
}

/** Numbers as written, in order: "42 %" -> "42%", "1,000" stays "1,000", "1 500" is "1500". Compare them with canonicalNumber. */
export function extractNumbers(s: string): string[] {
  return findNumbers(s).map((n) => n.value);
}

const COMMA_GROUPED = /^(-?)([1-9]\d{0,2}(?:,\d{3}){2,})((?:\.\d+)?%?)$/;
const LEADING_MINUS = /^-/;

/**
 * The form two numbers are compared in: a number grouped with two or more commas loses its grouping
 * ("1,250,000" and "1 250 000" are both "1250000"). A single comma group is NOT regrouped: "1,250" is
 * 1250 in US text and 1.25 in Latvian, so it never equals "1 250" or "1250" (that fails safe), and a decimal
 * comma ("3,5", "0,500") is left alone. With `ignoreSign` a leading minus is dropped too (claims are compared
 * that way).
 */
export function canonicalNumber(
  value: string,
  opts: { ignoreSign?: boolean } = {}
): string {
  const v = opts.ignoreSign ? value.replace(LEADING_MINUS, "") : value;
  const m = COMMA_GROUPED.exec(v);
  return m
    ? `${m[1] ?? ""}${(m[2] ?? "").replaceAll(",", "")}${m[3] ?? ""}`
    : v;
}

// Two rows of the table, reused by every call: a window search makes thousands of comparisons, and
// allocating two arrays per comparison made them GC-bound on a large heap. Single-threaded and not
// re-entrant, so sharing them is safe. Only the band a row reads is ever written first (see fillBandRow).
let scratchA = new Int32Array(0);
let scratchB = new Int32Array(0);
// Always a real meter object (callers that do not count get this one): the JIT sees one shape, not "sometimes undefined".
const UNMETERED = { cells: 0 };

/**
 * Edit distance between `a` and `b`. With a finite `max` it only computes the diagonal band of
 * width `max` and gives up as soon as a whole row exceeds it, returning `max + 1`: callers that
 * only care whether the distance is within a budget pay O(max * length), not O(length^2).
 * `max` is a whole number of edits. When a `meter` is given, the table cells computed (and the row
 * set-up) are added to `meter.cells`, so a caller can bound its total work across many comparisons.
 */
export function levenshtein(
  a: string,
  b: string,
  max = Number.POSITIVE_INFINITY,
  meter: { cells: number } = UNMETERED
): number {
  if (a === b) {
    return 0;
  }
  const la = a.length;
  const lb = b.length;
  // Unbounded is a band as wide as the table. Keeping `limit` a whole number (never Infinity) matters:
  // JavaScriptCore stays slow for the rest of the process once a hot loop like this has seen an Infinity.
  const limit = Number.isFinite(max) ? Math.floor(max) : Math.max(la, lb);
  if (Math.abs(la - lb) > limit) {
    return limit + 1;
  }
  const band = Math.min(limit, Math.max(la, lb));
  const over = band + 1;
  if (scratchA.length < lb + 1) {
    scratchA = new Int32Array(lb + 1);
    scratchB = new Int32Array(lb + 1);
  }
  let prev = scratchA;
  let cur = scratchB;
  for (let j = 0; j <= lb; j += 1) {
    prev[j] = j <= band ? j : over;
  }
  meter.cells += lb + 1;
  for (let i = 1; i <= la; i += 1) {
    meter.cells += Math.min(lb, i + band) - Math.max(1, i - band) + 1;
    if (fillBandRow(a, b, i, band, prev, cur) > band) {
      return limit + 1;
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[lb] ?? over;
  return dist > limit ? limit + 1 : dist;
}

/**
 * Fills row `i` of the banded table into `cur` from the previous row `prev` and returns the smallest
 * value in it. Cells outside the band hold `band + 1`, so reads at the band's edge stay correct.
 */
function fillBandRow(
  a: string,
  b: string,
  i: number,
  band: number,
  prev: Int32Array,
  cur: Int32Array
): number {
  const over = band + 1;
  const lo = Math.max(1, i - band);
  const hi = Math.min(b.length, i + band);
  cur[lo - 1] = lo === 1 ? i : over;
  let rowMin = cur[lo - 1] ?? over;
  const ca = a.charCodeAt(i - 1);
  for (let j = lo; j <= hi; j += 1) {
    const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
    const value = Math.min(
      (prev[j] ?? over) + 1,
      (cur[j - 1] ?? over) + 1,
      (prev[j - 1] ?? over) + cost
    );
    cur[j] = value;
    rowMin = Math.min(rowMin, value);
  }
  if (hi < b.length) {
    cur[hi + 1] = over;
  }
  return rowMin;
}

export function levenshteinRatio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}
