import type { EngineConfig } from "../../engine/config.js";
import { lintArticle } from "../../engine/components/lint.js";
import { type GateIssue, type GateResult, gateBlockers, gateResult } from "../../engine/gates/types.js";
import { hrefsOf } from "../../engine/gates/links.js";
import { voiceGate } from "../../engine/gates/voice.js";
import { maskCode } from "../../engine/markdown/mask-code.js";
import { FAQ_HEADING_RE } from "../../engine/markdown/faq.js";
import { toPlainText } from "../../engine/markdown/plain-text.js";
import type { ComponentProfile } from "../../engine/profile.js";
import { untranslatedBlogLinks } from "./links.js";
import type { LocaleSetting } from "./settings.js";

/** What the checks read of one version of the article. */
export type CheckText = { title: string; description: string; markdown: string };
export type CheckedTranslation = CheckText & { slug: string };

/** One problem found in a translation, as stored on the translation and shown to its editor. */
export type Finding = { gate: string; severity: "blocker" | "warning"; message: string; excerpt?: string; hint?: string };

export const SLUG_MAX = 100;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ABSOLUTE_URL_RE = /^https?:\/\//i;
const MARK_LINK_RE = /\[[⁰¹²³⁴⁵⁶⁷⁸⁹]+\]\([^)\s]+\)/g;
const SOURCES_ITEM_RE = /^\d+\.[ \t].*?\]\(([^)\s]+)\)/gm;
const QUESTION_END_RE = /[?？؟]\s*$/;
const FAQ_ANSWER_MIN = 20;

const SPECIAL: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ł: "l", þ: "th", ð: "d", ı: "i" };

/** ASCII kebab-case: diacritics dropped, anything else that is not a letter or digit becomes a hyphen. */
export function asciiSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ßæœøđłþðı]/g, (c) => SPECIAL[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const externalLinks = (markdown: string) => new Set(hrefsOf(markdown).filter((h) => ABSOLUTE_URL_RE.test(h)));
const markLinks = (markdown: string) => [...markdown.matchAll(MARK_LINK_RE)].map((m) => m[0]);

type Section = { heading: string; body: string };
/** The `##` sections of an article, code ignored. Text before the first `##` is not a section. */
function h2Sections(markdown: string): Section[] {
  const masked = maskCode(markdown).split("\n");
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let current: { heading: string; body: string[] } | null = null;
  masked.forEach((m, i) => {
    const h = /^ {0,3}##[ \t]+(.*?)[ \t#]*$/.exec(m);
    if (h && !/^ {0,3}###/.test(m)) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n") });
      current = { heading: h[1] ?? "", body: [] };
    } else current?.body.push(lines[i] ?? "");
  });
  if (current) sections.push({ heading: (current as { heading: string }).heading, body: (current as { body: string[] }).body.join("\n") });
  return sections;
}

const listDestinations = (body: string) => [...body.matchAll(SOURCES_ITEM_RE)].map((m) => m[1] ?? "");

/**
 * Parity with the English text. The Lindevo profile uses the vendored component linter (same components in the same
 * order, same service and anchor); the markdown profile compares how many H2s, H3s, list items and blockquote lines
 * the two texts have.
 */
export function parityGate(en: string, tr: string, profile: ComponentProfile): GateResult {
  if (profile === "lindevo") {
    const issues = lintArticle({ en, lv: tr }).issues
      .filter((i) => i.locale === "lv" && i.severity === "error")
      .map((i): GateIssue => ({ message: `line ${i.line}: ${i.rule}: ${i.message}`, ...(i.hint ? { hint: i.hint } : {}) }));
    return gateResult("parity", issues);
  }
  const count = (md: string) => {
    const lines = maskCode(md).split("\n");
    const n = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    return { "H2 headings": n(/^ {0,3}##(?!#)[ \t]/), "H3 headings": n(/^ {0,3}###(?!#)[ \t]/), "list items": n(/^\s*(?:[-*+]|\d+[.)])[ \t]+\S/), "blockquote lines": n(/^ {0,3}>/) };
  };
  const a = count(en);
  const b = count(tr);
  const issues = (Object.keys(a) as (keyof typeof a)[])
    .filter((k) => a[k] !== b[k])
    .map((k): GateIssue => ({ message: `the translation has ${b[k]} ${k}; the English text has ${a[k]}`, hint: "keep the same structure as the English text" }));
  return gateResult("parity", issues);
}

/**
 * Citations carry over unchanged: no `{{c:` marker is left, the same external URLs are linked, the numbered marks
 * (`[¹](url)`) are the same in the same order, and the English `## Sources` list appears once, localized, with the same
 * destinations. A heading left as the English word is only a warning (it is the right word in some languages).
 */
export function citationsGate(en: string, tr: string): GateResult {
  const issues: GateIssue[] = [];
  if (tr.includes("{{c:")) issues.push({ message: "citation markers must not appear in the translation" });
  const enLinks = externalLinks(en);
  const trLinks = externalLinks(tr);
  for (const url of enLinks) {
    if (!trLinks.has(url)) issues.push({ excerpt: url, hint: "keep every link URL exactly as in English and translate only its text", message: `the translation drops the link ${url}` });
  }
  for (const url of trLinks) {
    if (!enLinks.has(url)) issues.push({ excerpt: url, message: `the translation links ${url}, which the English text does not` });
  }
  const enMarks = markLinks(en);
  if (!sameList(enMarks, markLinks(tr))) {
    issues.push({
      hint: "keep every superscript number and its link exactly where it stands in English, in the same order",
      message: `the translation has ${markLinks(tr).length} numbered source marks; the English text has ${enMarks.length}, and they must match one to one`,
    });
  }
  const enList = listDestinations(h2Sections(en).find((s) => s.heading === "Sources")?.body ?? "");
  if (enList.length > 0) {
    const matching = h2Sections(tr).filter((s) => sameList(enList, listDestinations(s.body)));
    if (matching.length !== 1) {
      issues.push({
        hint: "end the article with one numbered Sources list with the same links in the same order; translate only the heading and the titles",
        message: matching.length === 0
          ? `the translation has no sources list matching the English one (${enList.length} sources)`
          : "the translation repeats the sources list",
      });
    }
  }
  return gateResult("citations", issues);
}

/** Title and description limits, and the slug rules (ASCII words joined by hyphens). */
export function metaGate(tr: CheckedTranslation, en: CheckText, cfg: EngineConfig["gates"]): GateResult {
  const issues: GateIssue[] = [];
  if (!tr.title.trim()) issues.push({ message: "the translated title is empty" });
  else if (tr.title.length > cfg.titleMax) issues.push({ excerpt: tr.title, message: `title is ${tr.title.length} characters; allowed up to ${cfg.titleMax}` });
  if (en.description.trim() && !tr.description.trim()) issues.push({ message: "the translated description is empty" });
  if (tr.description.length > cfg.descriptionMax) issues.push({ excerpt: tr.description, message: `description is ${tr.description.length} characters; allowed up to ${cfg.descriptionMax}` });
  if (!SLUG_RE.test(tr.slug) || tr.slug.length > SLUG_MAX) issues.push({ excerpt: tr.slug, message: `slug must be ASCII words joined by hyphens, at most ${SLUG_MAX} characters` });
  return gateResult("meta", issues);
}

/** The FAQ section (the H2 at the English FAQ's position) keeps its questions: each ends with "?" and has an answer. */
export function faqGate(en: string, tr: string): GateResult {
  const enSections = h2Sections(en);
  const trSections = h2Sections(tr);
  const at = enSections.findIndex((s) => FAQ_HEADING_RE.test(`## ${s.heading}`));
  if (at === -1 || enSections.length !== trSections.length) return gateResult("faq", []);
  const entries = (body: string) => {
    const out: { question: string; answer: string }[] = [];
    const lines = body.split("\n");
    const masked = maskCode(body).split("\n");
    let cur: { question: string; answer: string[] } | null = null;
    masked.forEach((m, i) => {
      const h = /^ {0,3}###(?!#)[ \t]+(.*?)[ \t#]*$/.exec(m);
      if (h) {
        if (cur) out.push({ question: cur.question, answer: cur.answer.join("\n") });
        cur = { question: h[1] ?? "", answer: [] };
      } else cur?.answer.push(lines[i] ?? "");
    });
    if (cur) out.push({ question: (cur as { question: string }).question, answer: (cur as { answer: string[] }).answer.join("\n") });
    return out;
  };
  const enFaq = entries(enSections[at]!.body);
  const trFaq = entries(trSections[at]!.body);
  const issues: GateIssue[] = [];
  if (trFaq.length < enFaq.length) issues.push({ message: `the translated FAQ has ${trFaq.length} questions; the English one has ${enFaq.length}` });
  for (const q of trFaq) {
    const question = toPlainText(q.question).trim();
    if (!QUESTION_END_RE.test(question)) issues.push({ excerpt: question, message: "FAQ question must end with a question mark" });
    if (toPlainText(q.answer).trim().length < FAQ_ANSWER_MIN) issues.push({ excerpt: question, message: `FAQ answer is shorter than ${FAQ_ANSWER_MIN} characters` });
  }
  return gateResult("faq", issues);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The locale's informal forms of address are blockers, matched as whole words, case-insensitively. */
export function formalAddressGate(text: string, locale: LocaleSetting): GateResult {
  const nfc = text.normalize("NFC");
  const issues: GateIssue[] = [];
  for (const word of locale.formalAddress?.forbidden ?? []) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word.normalize("NFC"))}(?![\\p{L}\\p{N}])`, "iu").exec(nfc);
    if (m) issues.push({ excerpt: m[0], hint: "use the formal form of address", message: `uses the informal "${word}"` });
  }
  return gateResult("formal-address", issues);
}

const CODE_FENCE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK_TARGET_RE = /\]\([^)\s]*[^)]*\)/g;
const TAG_RE = /<[^>]*>/g;
/** Words are split at punctuation, so a pair never spans a clause. */
const CLAUSE_SPLIT_RE = /[.!?;:,()[\]\n"“”„«»—–]+/;
const WORD_RE = /[\p{L}]+/gu;
const MIN_STEM = 6;
const JA_PREFIX = "jā";
const REPEAT_EXCERPT_MAX = 80;

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Adjacent words of one clause that share a stem of 6+ letters (case ignored) are a word repeated in two forms, which
 * a model writes and a reader notices. For Latvian a leading "jā" is ignored first. A cheap hint, not a gate: it can be
 * wrong, so it never fails a translation on its own.
 */
export function repeatedStems(markdown: string, locale = ""): string[] {
  const strip = (w: string) => (locale.startsWith("lv") && w.startsWith(JA_PREFIX) && w.length - JA_PREFIX.length >= MIN_STEM ? w.slice(JA_PREFIX.length) : w);
  const text = markdown.replace(CODE_FENCE_RE, " ").replace(LINK_TARGET_RE, "]").replace(TAG_RE, " ");
  const hits = new Set<string>();
  for (const clause of text.split(CLAUSE_SPLIT_RE)) {
    const words = clause.match(WORD_RE) ?? [];
    for (let i = 1; i < words.length; i += 1) {
      const a = strip((words[i - 1] as string).toLowerCase());
      const b = strip((words[i] as string).toLowerCase());
      if (a.length >= MIN_STEM && sharedPrefix(a, b) >= MIN_STEM) hits.add(`${words[i - 1]} ${words[i]}`.slice(0, REPEAT_EXCERPT_MAX));
    }
  }
  return [...hits];
}

export type CheckInput = {
  en: CheckText;
  tr: CheckedTranslation;
  locale: LocaleSetting;
  profile: ComponentProfile;
  gates: EngineConfig["gates"];
  /** The engine voice rules with the site's banned words and phrases added (`withSiteVoice`). */
  voice: EngineConfig["voice"];
};

/** Every code check on a translation. The model review is added by the caller. */
export function translationChecks(input: CheckInput): GateResult[] {
  const { en, tr, locale } = input;
  const plain = `${tr.title}\n${tr.description}\n${toPlainText(tr.markdown)}`;
  const staleLinks = untranslatedBlogLinks(tr.markdown);
  const sourcesLeft = tr.markdown.split("\n").some((l) => l.trim() === "## Sources") && !locale.locale.startsWith("fr");
  return [
    parityGate(en.markdown, tr.markdown, input.profile),
    citationsGate(en.markdown, tr.markdown),
    metaGate(tr, en, input.gates),
    faqGate(en.markdown, tr.markdown),
    formalAddressGate(plain, locale),
    ...voiceGate(plain, input.voice),
    gateResult("repeat", repeatedStems(tr.markdown, locale.locale).map((phrase) => ({
      excerpt: phrase,
      hint: "a word or its stem appears twice in a row in two forms; rewrite the phrase as one grammatical phrase",
      message: "a word repeated in two forms in one phrase",
    })), "warning"),
    gateResult("links", [
      ...staleLinks.map((url): GateIssue => ({ excerpt: url, message: "links to the English edition of another post, which has no translation in this language yet" })),
      ...(sourcesLeft ? [{ message: 'the sources heading is still the English "Sources"' }] : []),
    ], "warning"),
  ];
}

/** Every failed check as a finding: blockers first, then warnings. */
export function toFindings(results: GateResult[]): Finding[] {
  const out = results.filter((r) => !r.passed).flatMap((r) => r.issues.map((i): Finding => ({
    gate: r.gate,
    severity: r.severity,
    message: i.message,
    ...(i.excerpt ? { excerpt: i.excerpt.slice(0, 300) } : {}),
    ...(i.hint ? { hint: i.hint.slice(0, 300) } : {}),
  })));
  return [...out.filter((f) => f.severity === "blocker"), ...out.filter((f) => f.severity === "warning")];
}

export { gateBlockers };
