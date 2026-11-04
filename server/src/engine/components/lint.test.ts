// Ported from Lindevo packages/mdx/src/lint.test.ts (2026-11-05): one case per rule id the linter can raise.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues, lintArticle, splitSourcesSection } from "./lint.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8");
const rules = (en: string, lv?: string) => lintArticle(lv === undefined ? { en } : { en, lv }).issues.map((i) => i.rule);
const step = (title: string) => `<workflow-step kind="ai" title="${title}">\nA\n</workflow-step>\n`;
const cta = '<service-cta service="save-time"></service-cta>\n';

describe("lint parity with Lindevo", () => {
  test("the engine fixture passes in both locales, also with CRLF", () => {
    const en = fixture("engine-post.md");
    const lv = fixture("engine-post.lv.md");
    expect(formatIssues(lintArticle({ en, lv }).issues)).toBe("");
    const crlf = (t: string) => t.replaceAll("\n", "\r\n");
    expect(formatIssues(lintArticle({ en: crlf(en), lv: crlf(lv) }).issues)).toBe("");
  });

  test("tags, attributes and structure", () => {
    expect(rules("Text\n\n<widget></widget>\n")).toContain("unknown-tag");
    expect(rules('<callout tone="info">\nHi\n</callout>\n')).toContain("unknown-attr");
    expect(rules('<callout variant="loud">\nHi\n</callout>\n')).toContain("invalid-attr-value");
    expect(rules("<service-cta></service-cta>\n")).toContain("missing-attr");
    expect(rules("<callout>\nHi\n")).toContain("unclosed-tag");
    expect(rules("Text\n\n</callout>\n")).toContain("unexpected-close-tag");
    expect(rules('<service-cta service="save-time" />\n')).toContain("self-closing-tag");
    expect(rules('<workflow-step kind="ai" title="x">\nA\n</workflow-step>\n')).toContain("invalid-parent");
    expect(rules("<case-stats>\n<callout>\nHi\n</callout>\n</case-stats>\n")).toContain("invalid-child");
    expect(rules(`${cta}\n${cta}`)).toContain("max-count");
    expect(rules('<service-cta service="save-time">words</service-cta>\n')).toContain("unexpected-body");
    expect(rules(`<workflow>\n\n${step("One")}\nIn between.\n\n${step("Two")}\n</workflow>\n`)).toContain("unexpected-text");
  });

  test("counts, blank lines and provenance", () => {
    expect(rules("<key-takeaways>\n\n- One\n- Two\n\n</key-takeaways>\n")).toContain("takeaways-count");
    expect(rules(`<workflow>\n\n${step("Only")}\n</workflow>\n`)).toContain("workflow-step-count");
    expect(rules(`Text\n${cta}`)).toContain("blank-lines");
    const prov = '<provenance sources="1" checks="1" reviewer="N" reviewed="2026-10-03"></provenance>\n\nMore text.\n';
    expect(rules(prov)).toContain("provenance-not-last");
  });

  test("headings and FAQ", () => {
    expect(rules("# Title\n\nText\n")).toContain("no-h1");
    expect(rules("## A\n\n#### B\n")).toContain("heading-skip");
    expect(rules("<callout>\n\n## Inside\n\n</callout>\n")).toContain("heading-in-component");
    expect(rules("## FAQ\n\n### Pricing\n\nWe quote per engagement after a short call about the work.\n")).toContain("faq-question-mark");
    expect(rules("## FAQ\n\n### Is it safe?\n\nYes.\n")).toContain("faq-answer-too-short");
  });

  test("EN/LV parity", () => {
    const en = '<service-cta service="save-time" anchor="team-handoffs"></service-cta>\n';
    expect(rules(en, "<callout>\nSveiki\n</callout>\n")).toContain("parity-components");
    expect(rules(en, '<service-cta service="research" anchor="team-handoffs"></service-cta>\n')).toContain("parity-attrs");
  });

  test("the Sources section is split off before linting prose", () => {
    const { body, sources } = splitSourcesSection("## A\n\nText.\n\n## Sources\n\n1. [x](https://x.test)\n");
    expect(body).not.toContain("Sources");
    expect(sources?.count).toBe(1);
  });
});
