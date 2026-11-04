/** biome-ignore-all lint/style/noMagicNumbers: algorithm constants */

import { DAY_MS, wordCount } from "../util.js";
import type { EngineConfig } from "../config.js";
import {
  canonicalNumber,
  extractNumbers,
  findNumbers,
  levenshtein,
  normalizeText,
} from "./normalize.js";

export type VerifyReason =
  | "quote-length"
  | "source-status"
  | "source-stale"
  | "claim-number-not-in-quote"
  | "quote-not-found"
  | "quote-number-mismatch";

/**
 * `start`/`end` are character offsets into the NORMALIZED page (`normalizeText(page.markdown)`), not
 * into the raw markdown: they are stable for the same page and quote, and `normalizeText(markdown)`
 * is how a caller maps them back to text. `score` is 1 for an exact hit and the Levenshtein ratio for a
 * fuzzy one. On a failure it is null, except `quote-number-mismatch` (the ratio of the window whose
 * numbers differ) and a `quote-not-found` near miss (the best ratio just under minRatio): a ratio is
 * only reported when it was computed exactly, never as the sentinel of an abandoned comparison.
 */
export interface VerifyResult {
  end: number | null;
  reason: VerifyReason | null;
  score: number | null;
  start: number | null;
  verified: boolean;
}

/** How many page positions the window search tries, ranked by how many quote words vote for them. */
const MAX_WINDOW_STARTS = 64;
/** Each ranked start is widened by this many tokens either way, to absorb inserted or dropped words. */
const START_SPREAD = 2;
/** Only quote words of at least this many characters vote: shorter ones are everywhere. */
const MIN_ANCHOR_LENGTH = 4;
/** Absorbs float error in `(1 - minRatio) * length`, so a ratio of exactly 0.92 passes. */
const EPSILON = 1e-9;
/**
 * A flat length bound, `maxQuoteWords * MAX_CHARS_PER_WORD` characters (1,800 at the default 60 words):
 * a longer "quote" is a blob, not prose. It is not a per-word average, and it does not by itself bound the
 * comparison work (a 1,739-character quote is inside it): `MAX_WORK_CELLS` does that.
 */
const MAX_CHARS_PER_WORD = 30;
/**
 * The most Levenshtein table cells one `verifyQuote` call may compute (about 0.4 s of work). A realistic
 * 60-word quote (about 420 characters) needs about 20 million for a whole search of a 300 KB page, even
 * when its anchor words are everywhere; a 1,700-character quote against a page of near-copies of it needs
 * over a billion. When the budget runs out the search stops and the quote fails as `quote-not-found`:
 * a partial search is not a verdict, and failing is the safe side.
 */
export const MAX_WORK_CELLS = 150_000_000;
/** How far either side of an exact hit a number token can reach and still be read whole. */
const NUMBER_CONTEXT = 64;

const TOKEN = /\S+/g;
/**
 * Words that flip a claim ("did not report", "nav pieejams"). A fuzzy window must carry exactly the
 * quote's negations: one edit of "did not report" is 0.94 of "did report", and it says the opposite.
 * Latvian is a short list, not the `ne-` prefix ("nedēļa" is a week).
 */
const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "cannot",
  "ne",
  "nebija",
  "nebūs",
  "nekad",
  "nekas",
  "nekur",
  "neither",
  "nevar",
  "nevarēja",
  "nedrīkst",
  "neviens",
  "never",
  "no",
  "nobody",
  "none",
  "nor",
  "not",
  "nothing",
  "nowhere",
  "nav",
]);
const NEGATION_CONTRACTION = /n't$/;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const WORD_CHAR_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_CHAR_AFTER = /^[\p{L}\p{N}]/u;
const NO_POSITIONS: readonly number[] = [];
/** Neighbour offsets in the order they are tried: the ranked start itself first. */
const START_OFFSETS = [0, -1, 1, -2, 2].filter(
  (d) => Math.abs(d) <= START_SPREAD
);

interface Token {
  end: number;
  key: string;
  start: number;
}
interface WindowMatch {
  end: number;
  score: number;
  start: number;
}

/** Number lists are equal in order, each compared in canonical form ("1,500" and "1 500" are the same), sign included. */
const sameNumbers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  a.every((n, i) => canonicalNumber(n) === canonicalNumber(b[i] ?? ""));

/** A hit counts only on token boundaries: "grew by 3" is not inside "grew by 35%". */
function onTokenBoundary(text: string, start: number, end: number): boolean {
  return !(
    WORD_CHAR_BEFORE.test(text.slice(Math.max(0, start - 2), start)) ||
    WORD_CHAR_AFTER.test(text.slice(end, end + 2))
  );
}

/**
 * The numbers of the page that the span touches, each read whole: a "3" cut out of "3.5%", "500" out of
 * "1,500", "5%" out of "-5%" comes back as the full number token, so it no longer equals what was quoted.
 */
function numbersTouching(text: string, start: number, end: number): string[] {
  const from = Math.max(0, start - NUMBER_CONTEXT);
  return findNumbers(text.slice(from, end + NUMBER_CONTEXT))
    .filter((n) => from + n.start < end && from + n.end > start)
    .map((n) => n.value);
}

const JOINED_BEFORE = /[\p{N}%][^\s\p{L}\p{N}]$/u;
const JOINED_AFTER = /^[^\s\p{L}\p{N}]\p{N}/u;
const STARTS_WITH_NUMBER = /^\p{N}/u;
const ENDS_WITH_NUMBER = /[\p{N}%]$/u;
/**
 * A hit may not start or end inside a run of numbers joined by punctuation ("3-5%", "3/5", "10:30"): "5%"
 * is not in "3-5%", and "of 3" is not in "of 3/5".
 */
function cutsNumberRun(text: string, start: number, end: number): boolean {
  return (
    (STARTS_WITH_NUMBER.test(text.slice(start, start + 1)) &&
      JOINED_BEFORE.test(text.slice(Math.max(0, start - 2), start))) ||
    (ENDS_WITH_NUMBER.test(text.slice(end - 1, end)) &&
      JOINED_AFTER.test(text.slice(end, end + 2)))
  );
}

/** The first exact hit on token boundaries whose numbers are exactly the quote's, or -1. */
function findExact(
  np: string,
  nq: string,
  quoteNumbers: readonly string[]
): number {
  let idx = np.indexOf(nq);
  while (idx >= 0) {
    const end = idx + nq.length;
    if (
      onTokenBoundary(np, idx, end) &&
      !cutsNumberRun(np, idx, end) &&
      sameNumbers(numbersTouching(np, idx, end), quoteNumbers)
    ) {
      return idx;
    }
    idx = np.indexOf(nq, idx + 1);
  }
  return -1;
}

/** The negation words of a normalized text, sorted: equal strings mean the same negations. */
function negationsOf(text: string): string {
  return text
    .split(" ")
    .map((w) => w.replace(EDGE_PUNCTUATION, ""))
    .filter((w) => NEGATION_WORDS.has(w) || NEGATION_CONTRACTION.test(w))
    .sort()
    .join(" ");
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((m) => ({
    end: (m.index ?? 0) + m[0].length,
    key: m[0].replace(EDGE_PUNCTUATION, ""),
    start: m.index ?? 0,
  }));
}

/**
 * Where a quote could start in the page, most promising first. Every page token equal to a long quote
 * word votes for the start it implies (page position minus the word's position in the quote); the
 * best-voted starts win, then each is widened by START_SPREAD tokens: all the ranked starts themselves
 * first, then their neighbours. Insertion order would drop the true window on a long page full of common
 * words, votes do not.
 */
function candidateStarts(
  tokens: readonly Token[],
  qWords: readonly string[]
): number[] {
  const anchors = new Map<string, number[]>();
  qWords.forEach((word, qi) => {
    const key = word.replace(EDGE_PUNCTUATION, "");
    if (key.length >= MIN_ANCHOR_LENGTH) {
      anchors.set(key, [...(anchors.get(key) ?? []), qi]);
    }
  });
  const votes = new Map<number, number>();
  tokens.forEach((token, pi) => {
    for (const qi of anchors.get(token.key) ?? NO_POSITIONS) {
      votes.set(pi - qi, (votes.get(pi - qi) ?? 0) + 1);
    }
  });
  const ranked = [...votes]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_WINDOW_STARTS);
  const starts = new Set<number>();
  for (const d of START_OFFSETS) {
    for (const [start] of ranked) {
      if (start + d >= 0 && start + d < tokens.length) {
        starts.add(start + d);
      }
    }
  }
  return [...starts];
}

interface WindowSearch {
  /** Highest-scoring window at or above minRatio, whatever its numbers. */
  best: WindowMatch | null;
  /** Highest-scoring window at or above minRatio whose number tokens equal the quote's, in order. */
  bestNumeric: WindowMatch | null;
  /** True when the work budget ran out before every candidate was compared. */
  exhausted: boolean;
  /** Best ratio under minRatio that was still within the edit budget: null when nothing came close. */
  nearMiss: number | null;
}

/** What one scored window adds to the search: a passing window is recorded, anything else is a near miss. */
function considerWindow(
  found: WindowSearch,
  w: {
    end: number;
    /** False when the window's negation words differ from the quote's. */
    negationsMatch: boolean;
    np: string;
    passes: boolean;
    quoteNumbers: readonly string[];
    score: number;
    start: number;
  }
): void {
  // Close in letters but opposite in meaning ("did report" for "did not report"): a near miss, never a match.
  if (!(w.passes && w.negationsMatch)) {
    found.nearMiss = Math.max(found.nearMiss ?? 0, w.score);
    return;
  }
  // The window's numbers are read from the page the same way as for an exact hit: a window whose
  // last token is the "3" of "3 %" (the % is the next token) still carries "3%".
  recordPassing(
    found,
    { end: w.end, score: w.score, start: w.start },
    numbersTouching(w.np, w.start, w.end),
    w.quoteNumbers
  );
}

/** Slides windows of quote length +/- windowSlack over the ranked starts and scores each with bounded Levenshtein. */
function searchWindows(
  nq: string,
  np: string,
  cfg: EngineConfig["evidence"],
  quoteNumbers: readonly string[],
  maxWorkCells: number,
  meter: { cells: number }
): WindowSearch {
  const tokens = tokenize(np);
  const qWords = nq.split(" ");
  const quoteNegations = negationsOf(nq);
  const lo = Math.max(1, Math.floor(qWords.length * (1 - cfg.windowSlack)));
  const hi = Math.ceil(qWords.length * (1 + cfg.windowSlack));
  const startCells = meter.cells;
  const found: WindowSearch = {
    best: null,
    bestNumeric: null,
    exhausted: false,
    nearMiss: null,
  };
  for (const s of candidateStarts(tokens, qWords)) {
    for (let w = lo; w <= hi; w += 1) {
      const first = tokens[s];
      const last = tokens[s + w - 1];
      if (!(first && last)) {
        break;
      }
      if (meter.cells - startCells > maxWorkCells) {
        found.exhausted = true;
        return found;
      }
      const text = np.slice(first.start, last.end);
      const scored = scoreWindow(nq, text, cfg.minRatio, meter);
      if (scored) {
        considerWindow(found, {
          end: last.end,
          negationsMatch: negationsOf(text) === quoteNegations,
          np,
          passes: scored.passes,
          quoteNumbers,
          score: scored.score,
          start: first.start,
        });
      }
    }
  }
  return found;
}

/** The window's ratio against the quote, or null when it is beyond the edit budget (budget = minRatio's edits + 1, for near-miss reporting). */
function scoreWindow(
  nq: string,
  text: string,
  minRatio: number,
  meter: { cells: number }
): { passes: boolean; score: number } | null {
  const maxLen = Math.max(text.length, nq.length);
  const maxEdits = Math.floor((1 - minRatio) * maxLen + EPSILON);
  const dist = levenshtein(nq, text, maxEdits + 1, meter);
  if (dist > maxEdits + 1) {
    return null;
  }
  // Rounded so a ratio of exactly minRatio reads as minRatio, not 0.9199999999999999.
  return {
    passes: dist <= maxEdits,
    score: Math.round((1 - dist / maxLen) * 1e6) / 1e6,
  };
}

/** Higher score wins; on a tie the earlier, then the shorter window, so the answer does not depend on the order tried. */
function isBetter(a: WindowMatch, b: WindowMatch | null): boolean {
  if (!b || a.score !== b.score) {
    return !b || a.score > b.score;
  }
  return a.start < b.start || (a.start === b.start && a.end < b.end);
}

/**
 * A window at or above minRatio: best overall, and best among those whose number tokens, extracted the
 * same way, equal the quote's number tokens in order. A window that merely contains the quote's numbers
 * (a wider one that borrows "42%" from the next sentence) does not count.
 */
function recordPassing(
  found: WindowSearch,
  window: WindowMatch,
  windowNumbers: readonly string[],
  quoteNumbers: readonly string[]
): void {
  if (isBetter(window, found.best)) {
    found.best = window;
  }
  if (
    sameNumbers(windowNumbers, quoteNumbers) &&
    isBetter(window, found.bestNumeric)
  ) {
    found.bestNumeric = window;
  }
}

export function verifyQuote(input: {
  claim: string;
  quote: string;
  page: { markdown: string; status: number; fetchedAt: Date };
  now: Date;
  config: EngineConfig["evidence"];
  /** Cap on Levenshtein table cells for this call (default MAX_WORK_CELLS); mainly for tests. */
  maxWorkCells?: number;
  /** Receives the Levenshtein table cells this call computed: lets a test assert on work done, not on the clock. */
  workMeter?: { cells: number };
}): VerifyResult {
  const fail = (
    reason: VerifyReason,
    score: number | null = null
  ): VerifyResult => ({
    end: null,
    reason,
    score,
    start: null,
    verified: false,
  });
  const cfg = input.config;
  const nq = normalizeText(input.quote);
  const words = wordCount(nq);
  if (
    words < cfg.minQuoteWords ||
    words > cfg.maxQuoteWords ||
    nq.length > cfg.maxQuoteWords * MAX_CHARS_PER_WORD
  ) {
    return fail("quote-length");
  }
  if (input.page.status !== 200) {
    return fail("source-status");
  }
  if (
    input.now.getTime() - input.page.fetchedAt.getTime() >
    cfg.maxSourceAgeDays * DAY_MS
  ) {
    return fail("source-stale");
  }
  const quoteNumbers = extractNumbers(nq);
  // A claim's number only has to be one of the quote's: "fell 5%" is backed by "-5%" (signs are ignored here,
  // not between the quote and the page), and "1 500" by "1,500".
  const quoteMagnitudes = quoteNumbers.map((n) =>
    canonicalNumber(n, { ignoreSign: true })
  );
  if (
    extractNumbers(normalizeText(input.claim)).some(
      (n) => !quoteMagnitudes.includes(canonicalNumber(n, { ignoreSign: true }))
    )
  ) {
    return fail("claim-number-not-in-quote");
  }
  const np = normalizeText(input.page.markdown);
  const idx = findExact(np, nq, quoteNumbers);
  if (idx >= 0) {
    return {
      end: idx + nq.length,
      reason: null,
      score: 1,
      start: idx,
      verified: true,
    };
  }
  const { best, bestNumeric, exhausted, nearMiss } = searchWindows(
    nq,
    np,
    cfg,
    quoteNumbers,
    input.maxWorkCells ?? MAX_WORK_CELLS,
    input.workMeter ?? { cells: 0 }
  );
  if (exhausted) {
    return fail("quote-not-found");
  }
  if (bestNumeric) {
    return {
      end: bestNumeric.end,
      reason: null,
      score: bestNumeric.score,
      start: bestNumeric.start,
      verified: true,
    };
  }
  if (best) {
    return fail("quote-number-mismatch", best.score);
  }
  return fail("quote-not-found", nearMiss);
}
