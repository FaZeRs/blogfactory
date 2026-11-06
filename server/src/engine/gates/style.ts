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

const ESCAPE_RE = /[.*+?^${}()|[\]\\/]/g;
const RULES = STYLE_PHRASES.map((phrase) => ({
  phrase,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(ESCAPE_RE, "\\$&").replace(/(?:\\?[\s-])+/g, "[\\s-]+")}(?![\\p{L}\\p{N}])`, "giu"),
}));

/** The sentence around a match, cut to the excerpt limit. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf(". ", index) + 2, text.lastIndexOf("\n", index) + 1, 0);
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
  const blocking = hits.length >= MAX_PHRASE_BLOCKER;
  return [
    gateResult("style", [...(blocking ? hits : []), ...dashIssues], "blocker", metrics),
    gateResult("style-warnings", blocking ? [] : hits, "warning"),
  ];
}
