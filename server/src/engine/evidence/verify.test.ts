/** biome-ignore-all lint/style/noMagicNumbers: test data, code points and timing bounds */
import { expect, test } from "bun:test";
import { ENGINE_CONFIG } from "../config.js";
import {
  canonicalNumber,
  extractNumbers,
  levenshtein,
  levenshteinRatio,
  normalizeText,
} from "./normalize.js";
import { MAX_WORK_CELLS, verifyQuote } from "./verify.js";

const now = new Date("2026-10-05T07:00:00Z");
const page = (
  markdown: string,
  extra: Partial<{ status: number; fetchedAt: Date }> = {}
) => ({
  fetchedAt: new Date("2026-10-04T07:00:00Z"),
  markdown,
  status: 200,
  ...extra,
});
const v = (claim: string, quote: string, markdown: string, extra = {}) =>
  verifyQuote({
    claim,
    config: ENGINE_CONFIG.evidence,
    now,
    page: page(markdown, extra),
    quote,
  });

/** Runs verifyQuote and also returns the Levenshtein cells it computed: work is asserted on that, not on the clock. */
const withMeter = (quote: string, markdown: string) => {
  const workMeter = { cells: 0 };
  const result = verifyQuote({
    claim: "x",
    config: ENGINE_CONFIG.evidence,
    now,
    page: page(markdown),
    quote,
    workMeter,
  });
  return { cells: workMeter.cells, result };
};
/** Generous wall-clock backstop for a loaded CI box; the real assertions are on the work counter. */
const BACKSTOP_MS = 5000;

// Typographic characters are built from code points, so no test depends on how this file's bytes are decoded.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const LDQ = cp(0x20_1c);
const RDQ = cp(0x20_1d);
const EM_DASH = cp(0x20_14);
const SOFT_HYPHEN = cp(0xad);

// Deterministic pseudo-random numbers, so the long-page fixtures are the same on every run.
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}

test("smart quotes and dashes normalize to an exact match", () => {
  const markdown = `Intro.\n\nThe report says ${LDQ}47% of firms use AI${RDQ} in 2025 ${EM_DASH} up from 30%. More text.`;
  const quote = 'The report says "47% of firms use AI" in 2025 - up from 30%.';
  const r = v("47% of firms used AI in 2025, up from 30%.", quote, markdown);
  expect(r).toMatchObject({ reason: null, score: 1, verified: true });
  expect(r.start).toBeGreaterThan(0);
  // start/end are offsets into the NORMALIZED page text, and they bound exactly the matched quote
  expect(normalizeText(markdown).slice(r.start ?? 0, r.end ?? 0)).toBe(
    normalizeText(quote)
  );
});

test("line-break hyphenation and markdown emphasis/links do not break a match", () => {
  const md =
    "Studies show that **small busi-\nnesses** that automate [order entry](https://x.org) save hours every single week of the year.";
  expect(
    v(
      "Small businesses that automate order entry save hours weekly.",
      "small businesses that automate order entry save hours every single week",
      md
    ).verified
  ).toBe(true);
});

test("a near-verbatim quote passes the 0.92 window; a paraphrase does not", () => {
  const md =
    "Teams that review every draft before sending report fewer complaints from customers each month, the survey found.";
  const near = v(
    "Teams that review drafts get fewer complaints.",
    "Teams that review every draft before sending reported fewer complaints from customers each month",
    md
  );
  expect(near.verified).toBe(true);
  expect(near.score).toBeLessThan(1);
  expect(near.score).toBeGreaterThanOrEqual(0.92);
  const paraphrase = v(
    "Most Latvian firms automate orders.",
    "Most companies in Latvia now rely on automation for nearly all of their orders",
    md
  );
  expect(paraphrase).toMatchObject({
    end: null,
    reason: "quote-not-found",
    start: null,
    verified: false,
  });
  expect(paraphrase.score === null || paraphrase.score < 0.92).toBe(true);
});

test("numbers must match verbatim even when the text is otherwise close", () => {
  const md =
    "In 2024, 24% of small firms used AI tools for customer replies across the whole region.";
  expect(
    v(
      "In 2024 a share of small firms used AI for replies.",
      "In 2024, 42% of small firms used AI tools for customer replies across the whole region.",
      md
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  expect(
    v(
      "Adoption reached 60% in 2024.",
      "In 2024, 24% of small firms used AI tools for customer replies across the whole region.",
      md
    )
  ).toMatchObject({ reason: "claim-number-not-in-quote" });
});

test("length, status and freshness rules", () => {
  const md =
    "Short quote here only five words long. And a much longer sentence follows it for padding purposes here.";
  expect(v("x", "Short quote here only five", md).reason).toBe("quote-length");
  const ok = "And a much longer sentence follows it for padding purposes here";
  expect(v("x", ok, md, { status: 404 }).reason).toBe("source-status");
  expect(
    v("x", ok, md, { fetchedAt: new Date("2026-09-01T00:00:00Z") }).reason
  ).toBe("source-stale");
  expect(v("x", ok, md).verified).toBe(true);
});

test("a quote over the word cap, or made of giant words, fails on length", () => {
  const long = Array.from({ length: 61 }, (_, i) => `word${i}`).join(" ");
  expect(v("x", long, long).reason).toBe("quote-length");
  const blob = Array.from(
    { length: 20 },
    (_, i) => `${"x".repeat(100)}${i}`
  ).join(" ");
  expect(v("x", blob, blob).reason).toBe("quote-length");
});

test("normalizer and number extraction", () => {
  expect(
    normalizeText(`A  ${LDQ}B${RDQ} ${EM_DASH} C${SOFT_HYPHEN}D\n\nE`)
  ).toBe('a "b" - cd e');
  expect(extractNumbers("Up 42 % from 1,000 in 2025 (3.5x)")).toEqual([
    "42%",
    "1,000",
    "2025",
    "3.5",
  ]);
});

test("every typographic quote, prime, dash, soft hyphen and guillemet normalizes to its ASCII form", () => {
  // U+2018-U+201B, U+2032, U+2039, U+203A are single quotes; U+201C-U+201F, U+00AB, U+00BB double quotes.
  for (const code of [
    0x20_18, 0x20_19, 0x20_1a, 0x20_1b, 0x20_32, 0x20_39, 0x20_3a,
  ]) {
    expect(normalizeText(`it${cp(code)}s`)).toBe("it's");
  }
  for (const code of [0x20_1c, 0x20_1d, 0x20_1e, 0x20_1f, 0xab, 0xbb]) {
    expect(normalizeText(`say ${cp(code)}hi${cp(code)}`)).toBe('say "hi"');
  }
  // U+2033 is NFKC-decomposed into two U+2032 primes; the pair is read as one double quote
  expect(normalizeText(`5${cp(0x20_33)}`)).toBe('5"');
  for (const code of [
    0x20_10, 0x20_11, 0x20_12, 0x20_13, 0x20_14, 0x20_15, 0x22_12,
  ]) {
    expect(normalizeText(`a ${cp(code)} b`)).toBe("a - b");
  }
  expect(normalizeText(`co${SOFT_HYPHEN}op`)).toBe("coop");
  // zero-width spaces and a BOM are invisible on the page and must not split words
  expect(normalizeText(`ze${cp(0x20_0b)}ro${cp(0xfe_ff)}`)).toBe("zero");
  // a Latvian page quoted with guillemets matches a straight-quote quote
  const lv = `Viņš teica ${cp(0xab)}automatizācija ietaupa laiku${cp(0xbb)} un tā ir taisnība pilnīgi katram uzņēmumam.`;
  const r = v(
    "x",
    'Viņš teica "automatizācija ietaupa laiku" un tā ir taisnība pilnīgi katram uzņēmumam.',
    `Sākums.\n\n${lv}`
  );
  expect(r).toMatchObject({ reason: null, score: 1, verified: true });
});

test("an ordinary compound word keeps its hyphen; only a line-break hyphen is joined", () => {
  expect(normalizeText("state-of-the-art tools")).toBe(
    "state-of-the-art tools"
  );
  expect(normalizeText("auto-\nmation")).toBe("automation");
  expect(normalizeText("auto-  \n  mation")).toBe("automation");
});

test("an exact hit must sit on token boundaries: '... grew by 3' is not found inside '... grew by 35%'", () => {
  const md =
    "Orders at the pilot restaurant grew by 35% during the first quarter after launch day.";
  const quote = "Orders at the pilot restaurant grew by 3";
  const r = v("Orders grew by 3 percent.", quote, md);
  expect(r).toMatchObject({
    end: null,
    reason: "quote-number-mismatch",
    start: null,
    verified: false,
  });
  expect(r.score).toBeGreaterThanOrEqual(0.92);
});

test("a boundary hit later in the page is still found when an earlier hit sits inside a longer word", () => {
  const md =
    "The preorders at the pilot restaurant grew by 3 percent. Then orders at the pilot restaurant grew by 3 percent again.";
  const quote = "orders at the pilot restaurant grew by 3";
  const r = v("Orders grew by 3 percent.", quote, md);
  expect(r).toMatchObject({ reason: null, score: 1, verified: true });
  expect(r.start).toBe(
    normalizeText(md).indexOf("then orders") + "then ".length
  );
});

test("when two windows are close, the one whose numbers match wins over a higher-scoring one that does not", () => {
  const md =
    "In 2024, 24% of small firms used AI tools for customer replies across the whole region. " +
    "Elsewhere in 2024, 42% of small firms used AI tools for customer replies across the whole area.";
  const quote =
    "In 2024, 42% of small firms used AI tools for customer replies across the whole region.";
  const r = v("In 2024 a share of small firms used AI tools.", quote, md);
  expect(r.verified).toBe(true);
  expect(r.score).toBeLessThan(1);
  expect(r.start).toBe(normalizeText(md).indexOf("in 2024, 42%"));
});

// ---- window search on a long page ----

const VOCAB = [
  "customers",
  "report",
  "fewer",
  "complaints",
  "review",
  "drafts",
];
const words = (rand: () => number, n: number) =>
  Array.from(
    { length: n },
    () => VOCAB[Math.floor(rand() * VOCAB.length)] ?? "report"
  );

/** ~300 KB of filler where every anchor word of the quote occurs thousands of times before the real passage. */
function longPage() {
  const rand = lcg(7);
  const filler = words(rand, 40_000).join(" ");
  const passageWords = words(rand, 60);
  const passage = passageWords.join(" ");
  const markdown = `${filler} ${passage} and then some closing words.`;
  // the quote is the passage with three substituted words: near-verbatim, so only the window search can find it
  const edited = [...passageWords];
  for (const i of [10, 30, 50]) {
    edited[i] = "xyzzy";
  }
  return { filler, markdown, passage, quote: edited.join(" ") };
}

test("window search recalls a 60-word near-verbatim quote on a 300 KB page full of its own anchor words", () => {
  const { markdown, passage, quote } = longPage();
  expect(markdown.length).toBeGreaterThan(250_000);
  const t0 = performance.now();
  const { cells, result: r } = withMeter(quote, markdown);
  const ms = performance.now() - t0;
  expect(r.verified).toBe(true);
  expect(r.score).toBeGreaterThanOrEqual(0.92);
  expect(r.score).toBeLessThan(1);
  expect(r.start).toBe(markdown.indexOf(passage));
  // about 23 M cells for the whole search, well inside the budget; the clock is only a backstop
  expect(cells).toBeLessThan(MAX_WORK_CELLS / 2);
  expect(ms).toBeLessThan(BACKSTOP_MS);
});

test("a miss against the same long page stays fast", () => {
  const { markdown } = longPage();
  const rand = lcg(99);
  const miss = words(rand, 60).join(" ");
  expect(markdown.includes(miss)).toBe(false);
  const t0 = performance.now();
  const { cells, result: r } = withMeter(miss, markdown);
  const ms = performance.now() - t0;
  expect(r).toMatchObject({ reason: "quote-not-found", verified: false });
  expect(cells).toBeLessThan(MAX_WORK_CELLS / 2);
  expect(ms).toBeLessThan(BACKSTOP_MS);
});

test("normalizing a hostile page (unterminated markup runs) stays near-linear", () => {
  const hostile = `${"![](".repeat(40_000)}${"<".repeat(100_000)}${"[x".repeat(50_000)}`;
  const t0 = performance.now();
  normalizeText(hostile);
  expect(performance.now() - t0).toBeLessThan(BACKSTOP_MS);
});

// ---- levenshtein ----

test("levenshtein: distances, early exit and ratio", () => {
  expect(levenshtein("kitten", "sitting")).toBe(3);
  expect(levenshtein("", "abc")).toBe(3);
  expect(levenshtein("same", "same")).toBe(0);
  expect(levenshtein("kitten", "sitting", 2)).toBe(3); // max + 1 once the distance exceeds the budget
  expect(levenshtein("kitten", "sitting", 3)).toBe(3);
  expect(levenshtein("short", "a much longer string", 4)).toBe(5);
  expect(levenshteinRatio("abcd", "abce")).toBe(0.75);
  expect(levenshteinRatio("", "")).toBe(1);
});

test("the bounded (banded) levenshtein agrees with the unbounded one for every budget", () => {
  const rand = lcg(3);
  const rnd = (n: number) =>
    Array.from({ length: n }, () => "abc"[Math.floor(rand() * 3)]).join("");
  for (let i = 0; i < 300; i += 1) {
    const a = rnd(Math.floor(rand() * 14));
    const b = rnd(Math.floor(rand() * 14));
    const full = levenshtein(a, b);
    for (const max of [0, 1, 2, 3, 5, 8]) {
      expect(levenshtein(a, b, max)).toBe(Math.min(full, max + 1));
    }
  }
});

// ---- fix round 1: numbers are compared as whole tokens, in order ----

const PILOT = "Orders at the pilot restaurant grew by";

test("number extraction keeps a leading minus only when it is a sign, not a hyphen or a range dash", () => {
  expect(
    extractNumbers("fell -5% and 2020-2025, covid-19, 1-2 weeks, (-3)")
  ).toEqual(["-5%", "2020", "2025", "19", "1", "2", "-3"]);
  expect(extractNumbers("up - 5% and 12 - 14")).toEqual(["5%", "12", "14"]);
});

test("an exact hit that cuts a number at a decimal point, comma, percent sign or minus is not a match", () => {
  const cut: [claim: string, quote: string, page: string][] = [
    [
      "Orders grew by 3 times.",
      `${PILOT} 3`,
      `${PILOT} 3.5% during the first quarter after the launch.`,
    ],
    [
      "Orders grew by 3 times.",
      `${PILOT} 3`,
      `${PILOT} 3% during the first quarter after the launch.`,
    ],
    [
      "500 small firms use AI.",
      "500 small firms in Latvia now use AI tools for customer replies",
      "1,500 small firms in Latvia now use AI tools for customer replies every single day.",
    ],
    [
      "Costs fell 5 million euros.",
      "5 million euros in the first quarter after launch at the pilot",
      "Costs at the pilot restaurant fell by 0.5 million euros in the first quarter after launch at the pilot.",
    ],
    [
      "Profit grew 5%.",
      "5% during the first quarter after the launch at the pilot",
      "Profit at the pilot restaurant changed by -5% during the first quarter after the launch at the pilot.",
    ],
  ];
  for (const [claim, quote, md] of cut) {
    expect(v(claim, quote, md)).toMatchObject({
      reason: "quote-number-mismatch",
      verified: false,
    });
  }
});

test("the same numbers verify exactly when the quote carries them whole", () => {
  expect(
    v(
      "Orders grew by 3.5%.",
      `${PILOT} 3.5%`,
      `${PILOT} 3.5% during the first quarter after the launch.`
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
  expect(
    v(
      "Profit grew -5%.",
      "-5% during the first quarter after the launch at the pilot",
      "Profit at the pilot restaurant changed by -5% during the first quarter after the launch at the pilot."
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
  expect(
    v(
      "1,500 small firms use AI.",
      "1,500 small firms in Latvia now use AI tools for customer replies",
      "1,500 small firms in Latvia now use AI tools for customer replies every single day."
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
});

test("a fuzzy window matches only when its numbers equal the quote's numbers, in order", () => {
  // the wrong % in the quoted sentence, the right % in the next one: the slack window must not borrow it
  const next =
    "In 2024, 24% of small firms used AI tools for customer replies across the whole region. 42% said they plan to.";
  const quoted =
    "In 2024, 42% of small firms used AI tools for customer replies across the whole region.";
  expect(
    v("In 2024 a share of small firms used AI.", quoted, next)
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  // "35%" quoted as "3", while the quote's second 3 is also in the window
  expect(
    v(
      "Orders grew by 3 in 3 regions.",
      `${PILOT} 3 in 3 regions during the first quarter`,
      `${PILOT} 35% in 3 regions during the first quarter.`
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  // 24 and 42 swapped
  expect(
    v(
      "42 of the small firms used AI.",
      "In 2024, 42 of the small firms we surveyed used AI tools for customer replies across 24 regions of the country.",
      "In 2024, 24 of the small firms we surveyed used AI tools for customer replies across 42 regions of the country."
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
});

test("only real tags are stripped: '< 5% ... >' is text, so 5% and 50% differ", () => {
  expect(normalizeText("a <b>bold</b> <a href='x'>link</a><br/> c")).toBe(
    "a bold link c"
  );
  expect(normalizeText("rural < 5% and 4 > 3")).toBe("rural < 5% and 4 3");
  const pageText =
    "Adoption is < 5% in rural areas and > 40% in cities across the whole region this year.";
  const quote =
    "Adoption is < 50% in rural areas and > 40% in cities across the whole region this year.";
  expect(
    v("Adoption is below 50% in rural areas.", quote, pageText)
  ).toMatchObject({
    reason: "quote-number-mismatch",
    verified: false,
  });
});

test("markdown backslash escapes are unescaped, a modifier apostrophe is an apostrophe, an em dash is not a hyphenation", () => {
  expect(
    normalizeText(String.raw`50\% of \*firms\* and snake\_case \# tag`)
  ).toBe("50% of firms and snake case tag");
  expect(normalizeText(`it${cp(0x2_bc)}s`)).toBe("it's");
  expect(normalizeText(`the result${EM_DASH}\nand this`)).toBe(
    "the result - and this"
  );
  expect(
    v(
      "50% of firms use AI.",
      "50% of the small firms in Latvia now use AI tools for customer replies",
      String.raw`50\% of the small firms in Latvia now use AI tools for customer replies.`
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
});

// ---- fix round 1: a bounded amount of comparison work ----

/** The reviewer's worst case: 60 random 28-letter words (1,739 chars) against a page of near-copies of it. */
function nearCopies(copies: number) {
  const rand = lcg(5);
  const word = () =>
    Array.from(
      { length: 28 },
      () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(rand() * 26)]
    ).join("");
  const quoteWords = Array.from({ length: 60 }, word);
  const pages: string[] = [];
  for (let c = 0; c < copies; c += 1) {
    const w = [...quoteWords];
    for (let k = 0; k < 8; k += 1) {
      w[Math.floor(rand() * 60)] = word();
    }
    pages.push(w.join(" "));
  }
  return { markdown: pages.join(" "), quote: quoteWords.join(" ") };
}

test("a 1,739-char quote against a 300 KB page of near-copies is cut off by the work budget", () => {
  const { markdown, quote } = nearCopies(175);
  expect(quote.length).toBe(1739);
  expect(markdown.length).toBeGreaterThan(300_000);
  const t0 = performance.now();
  const { cells, result: r } = withMeter(quote, markdown);
  const ms = performance.now() - t0;
  expect(r).toMatchObject({ reason: "quote-not-found", verified: false });
  // deterministic: the search stopped just past the budget (one comparison is under 1 M cells)
  expect(cells).toBeGreaterThan(MAX_WORK_CELLS);
  expect(cells).toBeLessThan(MAX_WORK_CELLS + 2_000_000);
  expect(ms).toBeLessThan(BACKSTOP_MS);
});

test("when the comparison work budget runs out the quote fails as not found, never verifies on a partial search", () => {
  const md =
    "Teams that review every draft before sending report fewer complaints from customers each month, the survey found.";
  const quote =
    "Teams that review every draft before sending reported fewer complaints from customers each month";
  expect(v("x", quote, md).verified).toBe(true);
  const r = verifyQuote({
    claim: "x",
    config: ENGINE_CONFIG.evidence,
    maxWorkCells: 50,
    now,
    page: page(md),
    quote,
  });
  expect(r).toMatchObject({
    end: null,
    reason: "quote-not-found",
    score: null,
    start: null,
    verified: false,
  });
});

test("levenshtein reports the cells it computed through an optional meter", () => {
  const meter = { cells: 0 };
  expect(levenshtein("kitten", "sitting", 3, meter)).toBe(3);
  expect(meter.cells).toBeGreaterThan(0);
  const before = meter.cells;
  expect(levenshtein("same", "same", 3, meter)).toBe(0);
  expect(meter.cells).toBe(before);
});

// ---- fix round 2: space before %, space-grouped thousands, signs, footnote refs ----

const NBSP = cp(0xa0);
const NARROW_NBSP = cp(0x20_2f);
const MINUS = cp(0x22_12);
const EN_DASH = cp(0x20_13);

test("a number cut at a space, NBSP or narrow NBSP before % is not a match, on the window path too", () => {
  for (const gap of [" ", NBSP, NARROW_NBSP]) {
    expect(
      v(
        "Orders grew by 3 times.",
        `${PILOT} 3`,
        `${PILOT} 3${gap}% during the first quarter after the launch.`
      )
    ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
    expect(
      v(
        "x",
        `${PILOT} 3,5`,
        `${PILOT} 3,5${gap}% during the first quarter after the launch.`
      )
    ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  }
  // the whole number, written with the same gap, still verifies
  expect(
    v(
      "Orders grew by 3 %.",
      `${PILOT} 3 %`,
      `${PILOT} 3${NBSP}% during the first quarter after the launch.`
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
});

test("NBSP and narrow NBSP are plain spaces after normalization", () => {
  expect(normalizeText(`1${NBSP}500 and 2${NARROW_NBSP}000`)).toBe(
    "1 500 and 2 000"
  );
});

test("a space-grouped thousands number is one number", () => {
  expect(
    extractNumbers(
      "1 500 firms, 12 345 678 people, in 2025 500 times, May 5 2025"
    )
  ).toEqual(["1500", "12345678", "2025", "500", "5", "2025"]);
  // a single comma group is ambiguous (LV "1,250" is 1.25): never regrouped. Two or more are unambiguous.
  expect(canonicalNumber("1,500")).toBe("1,500");
  expect(canonicalNumber("1,250")).toBe("1,250");
  expect(canonicalNumber("1,250,000")).toBe("1250000");
  expect(canonicalNumber("12,345,678.5")).toBe("12345678.5");
  expect(canonicalNumber("3,5")).toBe("3,5");
  expect(canonicalNumber("0,500")).toBe("0,500");
  expect(canonicalNumber("-1,250,000%")).toBe("-1250000%");
  expect(canonicalNumber("-5%", { ignoreSign: true })).toBe("5%");
});

test("'500' cut from a space-grouped '1 500' is not a match; the whole grouped number is", () => {
  const quote =
    "500 small firms in Latvia now use AI tools for customer replies";
  const tail =
    "small firms in Latvia now use AI tools for customer replies every single day.";
  for (const gap of [" ", NBSP, NARROW_NBSP]) {
    expect(
      v("500 small firms use AI.", quote, `1${gap}500 ${tail}`)
    ).toMatchObject({
      reason: "quote-number-mismatch",
      verified: false,
    });
  }
  const grouped = `1 500 ${tail}`;
  expect(
    v(
      "1 500 small firms use AI.",
      `1 500 ${tail.replace(" every single day.", "")}`,
      grouped
    )
  ).toMatchObject({ reason: null, score: 1, verified: true });
  // a single comma group is ambiguous (US 1,500, LV 1.5): "1,500" against "1 500" fails safe
  expect(
    v(
      "1,500 small firms use AI.",
      `1,500 ${tail.replace(" every single day.", "")}`,
      grouped
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  // two or more comma groups are unambiguous: 1,250,000 is 1 250 000, a fuzzy match
  const millions = v(
    "1,250,000 small firms use AI.",
    `1,250,000 ${tail.replace(" every single day.", "")}`,
    `1 250 000 ${tail}`
  );
  expect(millions.verified).toBe(true);
  expect(millions.score).toBeLessThan(1);
  // a claim's "1 250" is not backed by a quote's "1,250" (LV 1.25)
  expect(
    v(
      "1 250 firms.",
      "1,250 small firms in Latvia now use AI tools for customer replies",
      "1,250 small firms in Latvia now use AI tools for customer replies."
    )
  ).toMatchObject({ reason: "claim-number-not-in-quote", verified: false });
});

test("a claim number matches the quote's number whatever its sign; quote against page stays sign-exact", () => {
  const md =
    "Profit at the pilot restaurant changed by -5% during the first quarter after the launch at the pilot.";
  const quote =
    "Profit at the pilot restaurant changed by -5% during the first quarter";
  expect(v("Profit fell 5%.", quote, md)).toMatchObject({
    reason: null,
    verified: true,
  });
  expect(v("Profit fell -5%.", quote, md).verified).toBe(true);
  expect(
    v(
      "Profit fell 5%.",
      quote.replace("-5%", `${MINUS}5%`),
      md.replace("-5%", `${MINUS}5%`)
    ).verified
  ).toBe(true);
  // the quote says 5%, the page says -5%: still a mismatch
  expect(
    v(
      "Profit grew 5%.",
      "5% during the first quarter after the launch at the pilot",
      md
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
});

test("an em dash is a dash, never a minus sign", () => {
  const pageText = `Results ${EM_DASH}5% of the surveyed small firms said they plan to expand next year.`;
  const plain =
    "5% of the surveyed small firms said they plan to expand next year";
  expect(v("5% of firms plan to expand.", plain, pageText)).toMatchObject({
    reason: null,
    verified: true,
  });
  expect(
    v("5% of firms plan to expand.", `${EM_DASH}${plain}`, pageText).verified
  ).toBe(true);
  expect(
    extractNumbers(
      normalizeText(`2020${EN_DASH}2025, up${EM_DASH}5%, a ${EM_DASH} 5%`)
    )
  ).toEqual(["2020", "2025", "5%", "5%"]);
  // a real minus (U+2212 or the hyphen-minus) still is one
  expect(extractNumbers(normalizeText(`fell ${MINUS}5% and -3`))).toEqual([
    "-5%",
    "-3",
  ]);
});

test("footnote references on either side do not break a match", () => {
  const sentence = (marker: string) =>
    `The pilot restaurant chain grew by 35%${marker} between 2010 and 2020 across the region.`;
  const bare =
    "The pilot restaurant chain grew by 35% between 2010 and 2020 across the region";
  for (const marker of [
    "[12]",
    "<sup>1</sup>",
    "<sup>[12]</sup>",
    "[citation needed]",
    "[1][2]",
  ]) {
    expect(v("Chains grew 35%.", bare, sentence(marker))).toMatchObject({
      reason: null,
      score: 1,
      verified: true,
    });
    expect(
      v("Chains grew 35%.", sentence(marker).slice(0, -1), sentence(""))
        .verified
    ).toBe(true);
  }
  expect(
    normalizeText("grew 35%[12], then[citation needed] more<sup>3</sup> text")
  ).toBe("grew 35%, then more text");
  // an exponent is not a footnote: 10<sup>6</sup> and 10<sup>5</sup> stay different numbers
  expect(
    v(
      "10 million users.",
      "The pilot restaurant chain reached 10<sup>6</sup> users in the region this year",
      "The pilot restaurant chain reached 10<sup>5</sup> users in the region this year."
    ).verified
  ).toBe(false);
});

// ---- fix round 3: glued dashes, en dash as a minus, grouping, bracketed sup ----

test("a glued en or em dash is a hyphen: a quote typed with a hyphen verifies at 8-10 words, score 1", () => {
  const cases: [quote: string, page: string][] = [
    [
      "In 2024-2025 small firms across the region reported that",
      `In 2024${EN_DASH}2025 small firms across the region reported that`,
    ],
    [
      "In 2024-2025 small firms across the region reported that",
      `In 2024${EM_DASH}2025 small firms across the region reported that`,
    ],
    [
      "Costs fell 3-5% across small firms in the region",
      `Costs fell 3${EN_DASH}5% across small firms in the region`,
    ],
    [
      "Costs fell 3%-5% across small firms in the region",
      `Costs fell 3%${EM_DASH}5% across small firms in the region`,
    ],
    [
      "In 2024.-2025. small firms across the region reported growth",
      `In 2024.${EM_DASH}2025. small firms across the region reported growth`,
    ],
    [
      "In 2024.-2025. small firms across the region reported growth",
      `In 2024.${EN_DASH}2025. small firms across the region reported growth`,
    ],
    [
      "The final result-and the survey notes small firms reported",
      `The final result${EM_DASH}and the survey notes small firms reported`,
    ],
  ];
  for (const [quote, markdown] of cases) {
    const pageText = `Intro text here. ${markdown} and then more follows.`;
    expect(v("x", quote, pageText)).toMatchObject({
      reason: null,
      score: 1,
      verified: true,
    });
    // and the other way round: the dash in the quote, the hyphen on the page
    const dashed = quote.replace(
      "-",
      markdown.includes(EM_DASH) ? EM_DASH : EN_DASH
    );
    expect(
      v("x", dashed, `Intro text here. ${quote} and then more follows.`)
    ).toMatchObject({
      reason: null,
      score: 1,
      verified: true,
    });
  }
  // a dash with a space before it is still a spaced dash, not a hyphen
  expect(
    normalizeText(`a ${EN_DASH}b and a ${EM_DASH} b and up${EM_DASH}and`)
  ).toBe("a - b and a - b and up-and");
});

test("an en dash directly before a digit, not after a letter or digit, is a minus sign; an em dash never is", () => {
  const md = `Profit at the pilot restaurant changed by ${EN_DASH}5% during the first quarter after the launch.`;
  // dropping the minus fails; writing it as a hyphen or U+2212 or en dash verifies
  expect(
    v(
      "Profit fell 5%.",
      "Profit at the pilot restaurant changed by 5% during the first quarter",
      md
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  for (const minus of ["-", MINUS, EN_DASH]) {
    expect(
      v(
        "Profit fell 5%.",
        `Profit at the pilot restaurant changed by ${minus}5% during the first quarter`,
        md
      )
    ).toMatchObject({ reason: null, score: 1, verified: true });
  }
  // the same for a temperature in LV/EU typography
  const cold = `Overnight temperatures at the pilot restaurant fell to ${EN_DASH}5 °C during the cold week.`;
  expect(
    v(
      "x",
      "Overnight temperatures at the pilot restaurant fell to 5 °C during the cold week",
      cold
    )
  ).toMatchObject({ reason: "quote-number-mismatch", verified: false });
  expect(
    extractNumbers(
      normalizeText(`fell ${EN_DASH}5% and (${EN_DASH}3) but ${EM_DASH}4`)
    )
  ).toEqual(["-5%", "-3", "4"]);
  // after a letter or digit an en dash is a range dash, not a sign
  expect(
    extractNumbers(normalizeText(`pp. 3${EN_DASH}5, ${EN_DASH}7, a${EN_DASH}9`))
  ).toEqual(["3", "5", "-7", "9"]);
});

test("a bracketed sup directly after a digit is a footnote, not an exponent", () => {
  for (const marker of ["<sup>[12]</sup>", "<sup>[a]</sup>"]) {
    const pageText = `The pilot restaurant chain grew by 35 percent in 2020${marker} across the whole region.`;
    const quote =
      "The pilot restaurant chain grew by 35 percent in 2020 across the whole region";
    expect(v("x", quote, pageText)).toMatchObject({
      reason: null,
      score: 1,
      verified: true,
    });
  }
});

test("a hit may not start or end inside a number run joined by punctuation: '5%' is not in '3-5%'", () => {
  const quote = "5% of the customers answered the survey within a day";
  const rangePage =
    "In 2025, 3-5% of the customers answered the survey within a day.";
  expect(v("5% of customers answered", quote, rangePage).verified).toBe(false);
  // The whole range, and a plain 5%, still verify.
  expect(
    v(
      "3-5% of customers answered",
      "3-5% of the customers answered the survey within a day",
      rangePage
    )
  ).toMatchObject({ score: 1, verified: true });
  expect(
    v(
      "5% of customers answered",
      quote,
      "In 2025, 5% of the customers answered the survey within a day."
    ).verified
  ).toBe(true);
  // The same at the end of the quote: "of 3" is not in "of 3/5".
  const tail = "the customers who answered the survey within a day were 3";
  expect(
    v(
      "3 customers",
      tail,
      "Overall the customers who answered the survey within a day were 3/5 of all."
    ).verified
  ).toBe(false);
});

test("a fuzzy window must carry the quote's negations: 'did report' is not 'did not report'", () => {
  const source =
    "The vendor did not report any breach in its public filing last year.";
  const dropped = v(
    "The vendor reported a breach",
    "the vendor did report any breach in its public filing last year",
    source
  );
  expect(dropped.verified).toBe(false);
  expect(dropped.reason).toBe("quote-not-found");
  expect(dropped.score).toBeGreaterThan(0.9);
  // The contraction counts, and so does a negation the quote has but the page lacks.
  const contraction = v(
    "The vendor reported nothing",
    "the vendor didn't report any breach in its public filing last year",
    "The vendor did report any breach in its public filing last year."
  );
  expect(contraction.verified).toBe(false);
  // Same negation on both sides, one other word different: still a fuzzy match.
  expect(
    v(
      "The vendor reported nothing",
      "the vendor did not report any breaches in its public filing last year",
      source
    ).verified
  ).toBe(true);
  // Latvian: "nav" flips the claim; "nedeļa" (a week) is not a negation.
  const lvPage =
    "Piegādātājs nav ziņojis par pārkāpumiem savā publiskajā atskaitē pagājušajā gadā.";
  expect(
    v(
      "Piegādātājs ziņoja",
      "piegādātājs ir ziņojis par pārkāpumiem savā publiskajā atskaitē pagājušajā gadā",
      lvPage
    ).verified
  ).toBe(false);
  expect(
    v(
      "Atskaite iznāk reizi nedēļā",
      "publiskā atskaite iznāk reizi nedēļā pēc piegādātāja pārskata par pārkāpumiem",
      "Publiskā atskaite iznāk reizi nedēļā pēc piegādātāja pārskata par pārkāpumiem."
    ).verified
  ).toBe(true);
});

test("verifies Turkish and Latvian quotes with low-9 and guillemet marks", () => {
  const page = { markdown: "Uzņēmumu skaits pieauga par 12% 2025. gadā, liecina „Lursoft” dati par Latvijas tirgu un tā izaugsmi.", status: 200, fetchedAt: new Date("2026-11-01") };
  const r = verifyQuote({ claim: "Companies grew 12% in 2025.", quote: "Uzņēmumu skaits pieauga par 12% 2025. gadā, liecina \"Lursoft\" dati par Latvijas tirgu", page, now: new Date("2026-11-03"), config: ENGINE_CONFIG.evidence });
  expect(r.verified).toBe(true);
  const tr = verifyQuote({ claim: "İstanbul has 16 million residents.", quote: "İstanbul'un nüfusu 16 milyonu aştı ve şehir büyümeye devam ediyor", page: { ...page, markdown: "Son verilere göre İstanbul'un nüfusu 16 milyonu aştı ve şehir büyümeye devam ediyor." }, now: new Date("2026-11-03"), config: ENGINE_CONFIG.evidence });
  expect(tr.verified).toBe(true);
});
