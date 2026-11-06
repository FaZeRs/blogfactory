import { maskCode } from "../markdown/mask-code.js";
import { toPlainText } from "../markdown/plain-text.js";
import { wordCount } from "../util.js";
import { type GateIssue, type GateResult, gateResult } from "./types.js";

/** Machine-sounding phrases, matched case-insensitively on whole words; a space or hyphen matches either. */
export const STYLE_PHRASES: readonly string[] = [
  "delve", "delves", "delving", "in today's fast-paced", "it's important to note", "it is important to note",
  "it is worth noting", "it's worth noting", "unlock the power", "navigate the complexities", "tapestry", "game-changer",
  "in the realm of", "a testament to", "embark on", "elevate your", "seamlessly", "robust solution", "ever-evolving",
  "harness the power", "dive into", "at the end of the day", "in conclusion", "furthermore,", "moreover,",
  "in the ever-changing", "plays a crucial role", "a myriad of", "paradigm shift", "stands as a testament",
];

const MAX_PHRASE_BLOCKER = 3;
const MAX_DASHES_PER_1000 = 6;
const EXCERPT_MAX = 160;
const DASH_ISSUES_MAX = 8;
/** Plain-language articles average about 15-18 words a sentence; above this the prose reads dense. */
const MAX_MEAN_SENTENCE_WORDS = 22;
const MIN_SENTENCES_MEASURED = 20;
const LONG_SENTENCE_ISSUES = 5;
/** Readable posts average about two sentences (35-40 words) a paragraph; above this paragraphs read as walls. */
const MAX_MEAN_PARAGRAPH_WORDS = 45;
const MIN_PARAGRAPHS_MEASURED = 15;

/** The prose paragraphs as plain text: code, headings, lists, tables, quotes and component tags are left out. */
export function proseParagraphs(markdown: string): string[] {
  // Code is blanked first: a fence with blank lines inside would otherwise split into "paragraphs" of code.
  return maskCode(markdown).split(/\n\s*\n/).map((b) => b.trim())
    .filter((b) => b && !/^(#|[-*+] |\d+[.)] |<|>|\||```)/.test(b))
    .map((p) => p.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\{\{c:[^}]*\}\}/g, "").replace(/[\u00b9\u00b2\u00b3\u2070-\u2079]+/g, "").replace(/\s+/g, " "))
    .filter((p) => p.split(" ").length > 3);
}

export function proseSentences(markdown: string): string[] {
  // A sentence may also open with a number or bold text.
  return proseParagraphs(markdown).flatMap((p) => p.split(/(?<=[.!?])\s+(?=[\p{Lu}\d\u00c0-\u024f"'(*])/u))
    .map((x) => x.trim()).filter((x) => x.split(" ").length > 2);
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\/]/g;
const RULES = STYLE_PHRASES.map((phrase) => ({
  phrase,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(ESCAPE_RE, "\\$&").replace(/(?:\\?[\s-])+/g, "[\\s-]+")}(?![\\p{L}\\p{N}])`, "giu"),
}));

/** The sentence around a match, cut to the excerpt limit. */
function sentenceAround(text: string, index: number, length: number): string {
  const dot = text.lastIndexOf(". ", index);
  const start = Math.max(dot < 0 ? 0 : dot + 2, text.lastIndexOf("\n", index) + 1);
  const endAt = [text.indexOf(". ", index + length), text.indexOf("\n", index + length)].filter((n) => n >= 0);
  const end = endAt.length ? Math.min(...endAt) + 1 : text.length;
  const s = text.slice(start, end).trim();
  if (s.length <= EXCERPT_MAX) return s;
  const from = Math.max(0, index - start - 60);
  return s.slice(from, from + EXCERPT_MAX).trim();
}

/**
 * AI-tell check on the rendered text (code and link targets excluded): stock phrases and em dashes.
 * 3 or more phrase hits, or more than 6 em dashes per 1,000 words, block; fewer phrase hits are suggestions.
 */
export function styleGate(markdown: string): GateResult[] {
  const text = toPlainText(markdown).normalize("NFC").replace(/[\u2018\u2019]/g, "'");
  const hits = RULES.flatMap(({ phrase, re }) =>
    [...text.matchAll(re)].map((m): GateIssue => ({
      excerpt: sentenceAround(text, m.index ?? 0, m[0].length),
      hint: `Rewrite plainly without "${phrase.replace(/,$/, "")}"`,
      message: `machine-sounding phrase ("${phrase.replace(/,$/, "")}")`,
    })),
  );
  const words = wordCount(text);
  const dashes = [...text.matchAll(/\u2014/g)];
  const perThousand = words ? (dashes.length / words) * 1000 : 0;
  const metrics = { phraseHits: hits.length, emDashesPer1000: Math.round(perThousand * 10) / 10 };
  const dashIssues: GateIssue[] =
    perThousand > MAX_DASHES_PER_1000
      ? dashes.slice(0, DASH_ISSUES_MAX).map((m) => ({
          excerpt: sentenceAround(text, m.index ?? 0, 1),
          hint: "Replace the em dash with a comma, a full stop or brackets",
          message: `too many em dashes (${metrics.emDashesPer1000} per 1,000 words; the limit is ${MAX_DASHES_PER_1000})`,
        }))
      : [];
  const sentences = proseSentences(markdown);
  const lengths = sentences.map((x) => x.split(" ").length);
  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const meanSentenceWords = Math.round(mean * 10) / 10;
  const sentenceIssues: GateIssue[] =
    lengths.length >= MIN_SENTENCES_MEASURED && mean > MAX_MEAN_SENTENCE_WORDS
      ? sentences.map((x, i) => ({ x, n: lengths[i]! })).sort((a, b) => b.n - a.n).slice(0, LONG_SENTENCE_ISSUES).map(({ x, n }) => ({
          excerpt: x.length > EXCERPT_MAX ? `${x.slice(0, EXCERPT_MAX - 1)}…` : x,
          hint: "Split it into two or three short sentences, one idea each",
          message: `sentences average ${meanSentenceWords} words (keep the average under ${MAX_MEAN_SENTENCE_WORDS}); this one has ${n}`,
        }))
      : [];
  const paragraphs = proseParagraphs(markdown);
  const paraLengths = paragraphs.map((p) => p.split(" ").length);
  const paraMean = paraLengths.length ? paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length : 0;
  const meanParagraphWords = Math.round(paraMean);
  const paragraphIssues: GateIssue[] =
    paraLengths.length >= MIN_PARAGRAPHS_MEASURED && paraMean > MAX_MEAN_PARAGRAPH_WORDS
      ? paragraphs.map((p, i) => ({ p, n: paraLengths[i]! })).sort((a, b) => b.n - a.n).slice(0, LONG_SENTENCE_ISSUES).map(({ p, n }) => ({
          excerpt: p.length > EXCERPT_MAX ? `${p.slice(0, EXCERPT_MAX - 1)}…` : p,
          hint: "Split this paragraph in two, one idea each, keeping every sentence and marker",
          message: `paragraphs average ${meanParagraphWords} words (keep the average under ${MAX_MEAN_PARAGRAPH_WORDS}); this one has ${n}`,
        }))
      : [];
  const blocking = hits.length >= MAX_PHRASE_BLOCKER;
  return [
    gateResult("style", [...(blocking ? hits : []), ...dashIssues, ...sentenceIssues, ...paragraphIssues], "blocker", { ...metrics, meanSentenceWords, meanParagraphWords }),
    gateResult("style-warnings", blocking ? [] : hits, "warning"),
  ];
}
