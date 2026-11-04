import type { EngineConfig } from "../config.js";
import { normalizeText } from "../evidence/normalize.js";
import { toPlainText } from "../markdown/plain-text.js";
import {
  type GateInput,
  type GateIssue,
  type GateResult,
  gateResult,
} from "./types.js";

const GRAM_WORDS = 8;
/** A run of `n` matching 8-grams is a copied run of `n + GRAM_WORDS - 1` words. */
const RUN_EXTRA_WORDS = GRAM_WORDS - 1;
const MAX_COPIED_RUN_WORDS = 25;
const PERCENT = 100;
const MAX_QUOTED_CHARS = 400;
const SPACE = " ";
const NEWLINE = "\n";

/**
 * Quote marks as code points (no escape sequences in the source): the straight double quote, the curly
 * pair, the low-9 opening quote Latvian and German use, and the guillemets.
 */
const code = (n: number) => String.fromCodePoint(n);
const OPENING = ['"', code(0x20_1c), code(0x20_1e), code(0xab)].join("");
const CLOSING = ['"', code(0x20_1d), code(0x20_1c), code(0xbb)].join("");
const QUOTED_SPAN_RE = new RegExp(
  `[${OPENING}][^${CLOSING}\\n]{1,${MAX_QUOTED_CHARS}}[${CLOSING}]`,
  "g"
);

/**
 * Where a source is, for a blocker message that the revise prompt reads as instructions: the host only. The
 * rest of a crawled URL (its path after redirects) is text a page controls.
 */
function sourceHost(finalUrl: string): string {
  try {
    return new URL(finalUrl).host;
  } catch {
    return "a crawled source";
  }
}

const words = (t: string) => normalizeText(t).split(SPACE).filter(Boolean);
const grams = (ws: string[], n = GRAM_WORDS) => {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i += 1) {
    out.push(ws.slice(i, i + n).join(SPACE));
  }
  return out;
};

/** Quotes are allowed to match a source: drop blockquote lines and quoted spans. */
const stripQuotes = (md: string) =>
  md
    .split(NEWLINE)
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(NEWLINE)
    .replace(QUOTED_SPAN_RE, SPACE);

/**
 * Copying: at most `overlapMaxPercent` of the article's 8-word sequences may come from one source, and
 * no run of 25 or more words may be copied outside a quote. Only the sources an evidence row refers to
 * are compared: an earlier research attempt can leave crawled sources the writer never saw.
 */
export function overlapGate(
  input: Pick<GateInput, "evidence" | "markdown" | "sources">,
  cfg: EngineConfig["gates"]
): GateResult {
  const draft = grams(words(toPlainText(stripQuotes(input.markdown))));
  const used = new Set(input.evidence.map((e) => e.sourceId));
  const issues: GateIssue[] = [];
  let maxContainment = 0;
  let maxCopied = 0;
  for (const s of input.sources.filter((x) => used.has(x.id))) {
    const set = new Set(grams(words(s.markdown)));
    let hit = 0;
    let run = 0;
    let maxRun = 0;
    for (const g of draft) {
      if (set.has(g)) {
        hit += 1;
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    const containment = draft.length ? hit / draft.length : 0;
    maxContainment = Math.max(maxContainment, containment);
    if (containment * PERCENT > cfg.overlapMaxPercent) {
      issues.push({
        hint: "rewrite in your own words",
        message: `${(containment * PERCENT).toFixed(1)}% of the article's 8-word sequences come from ${sourceHost(s.finalUrl)}`,
      });
    }
    const runWords = maxRun ? maxRun + RUN_EXTRA_WORDS : 0;
    maxCopied = Math.max(maxCopied, runWords);
    if (runWords >= MAX_COPIED_RUN_WORDS) {
      issues.push({
        hint: "paraphrase, or quote a short part in a blockquote with its marker",
        message: `a ${runWords}-word run is copied from ${sourceHost(s.finalUrl)} outside a quote`,
      });
    }
  }
  return gateResult("overlap", issues, "blocker", {
    maxContainment,
    maxCopiedRunWords: maxCopied,
  });
}
