import { describe, expect, test } from "bun:test";
import { extractFaq, FAQ_HEADING_RE, scanFaq } from "./faq.js";

const article = [
  "Intro.",
  "",
  "## Frequently Asked Questions",
  "",
  "### Does it send replies on its own?",
  "",
  "No. A person on the team approves every reply before it goes out.",
  "",
  "### Pricing",
  "",
  "We quote per engagement after a short call about the work.",
  "",
  "### Is it fast?",
  "",
  "Yes.",
  "",
  "## Next section",
  "",
  "### Not part of the FAQ?",
  "",
  "This answer sits under a different section and must be ignored.",
].join("\n");

describe("FAQ_HEADING_RE", () => {
  test("matches whole FAQ heading lines in both locales", () => {
    for (const line of [
      "## Frequently Asked Questions",
      "## FAQ",
      "## Biežāk uzdotie jautājumi",
    ]) {
      expect(FAQ_HEADING_RE.test(line)).toBe(true);
    }
    expect(FAQ_HEADING_RE.test("## Pricing")).toBe(false);
    expect(FAQ_HEADING_RE.test("FAQ")).toBe(false);
  });

  test("is not global, so repeated tests give the same answer", () => {
    expect(FAQ_HEADING_RE.global).toBe(false);
    expect(FAQ_HEADING_RE.test("## FAQ")).toBe(true);
    expect(FAQ_HEADING_RE.test("## FAQ")).toBe(true);
  });
});

describe("extractFaq", () => {
  test("keeps only real questions with a full answer, inside the FAQ section", () => {
    expect(extractFaq(article)).toEqual([
      {
        answer:
          "No. A person on the team approves every reply before it goes out.",
        question: "Does it send replies on its own?",
      },
    ]);
  });

  test("no FAQ section, no items", () => {
    expect(
      extractFaq(
        "## Intro\n\n### A question?\n\nAn answer that is long enough to count.\n"
      )
    ).toEqual([]);
  });
});

describe("scanFaq", () => {
  test("reports every entry with its line, for the linter", () => {
    expect(
      scanFaq(article).map(({ isQuestion, line }) => ({ isQuestion, line }))
    ).toEqual([
      { isQuestion: true, line: 5 },
      { isQuestion: false, line: 9 },
      { isQuestion: true, line: 13 },
    ]);
  });
});

// The parser moved here from apps/web/src/lib/blog-faq.ts. These pin the
// behaviour the site already had, so FAQPage markup does not change.
describe("existing FAQ behaviour", () => {
  const answer = "An answer that is comfortably longer than forty characters.";

  test("a sibling ## closes the block", () => {
    const md = `## FAQ\n\n### First one here?\n\n${answer}\n\n## Other\n\n### Second one here?\n\n${answer}\n`;
    expect(extractFaq(md).map((item) => item.question)).toEqual([
      "First one here?",
    ]);
  });

  test("with no sibling ##, a top-level # closes the block", () => {
    const md = `## FAQ\n\n### First one here?\n\n${answer}\n\n# Other\n\n### Second one here?\n\n${answer}\n`;
    expect(extractFaq(md).map((item) => item.question)).toEqual([
      "First one here?",
    ]);
  });

  test("Latvian FAQ titles open the block", () => {
    for (const title of [
      "Biežāk uzdotie jautājumi",
      "Bieži uzdotie jautājumi",
      "BUJ",
    ]) {
      const md = `## ${title}\n\n### Vai tas ir drošs?\n\n${answer}\n`;
      expect(extractFaq(md)).toHaveLength(1);
    }
  });

  test("markup in headings and answers is flattened", () => {
    const md = [
      "## **FAQ**",
      "",
      "### Is the [pricing](/services) `fixed`?",
      "",
      "Yes, per *engagement*, see [the page](/pricing).<!-- note -->",
      "",
      "| a | b |",
      "| - | - |",
      "",
      "```ts",
      "const skipped = true;",
      "```",
      "",
      "#### A deeper heading kept as text",
      "",
      "> quoted line",
      "- listed line",
    ].join("\n");
    expect(extractFaq(md)).toEqual([
      {
        answer:
          "Yes, per engagement, see the page.\n\nA deeper heading kept as text\n\nquoted line listed line",
        question: "Is the pricing fixed?",
      },
    ]);
  });

  test("Windows line endings give the same result", () => {
    expect(extractFaq(article.replaceAll("\n", "\r\n"))).toEqual(
      extractFaq(article)
    );
  });

  test("short questions and short answers are dropped", () => {
    const md = `## FAQ\n\n### Why?\n\n${answer}\n\n### Is it short?\n\nYes.\n`;
    expect(extractFaq(md)).toEqual([]);
  });

  test("a long run of spaces in a heading is read in linear time", () => {
    const gap = " ".repeat(5000);
    const md = `## FAQ\n\n### Is it quick${gap}?\n\n${answer}\n\n## a${gap}b\n`;
    extractFaq(`## FAQ\n\n### Warm up?\n\n${answer}\n`);
    const started = performance.now();
    expect(extractFaq(md)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("scanFaq keeps the answer of an entry that is not a question", () => {
    expect(scanFaq(article)[1]).toEqual({
      answer: "We quote per engagement after a short call about the work.",
      isQuestion: false,
      line: 9,
      question: "Pricing",
    });
  });
});
