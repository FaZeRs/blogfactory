import { expect, test } from "bun:test";
import type { EvidenceItem, SourceItem } from "./gates/types.js";
import { CITATION_MARKER_RE, renderCitations, renderCitationsDetailed } from "./citations.js";

const src = (id: string, url: string, title: string | null = null): SourceItem => ({
  finalUrl: url,
  id,
  markdown: "",
  title,
  url,
});
const ev = (id: string, sourceId: string, verified = true): EvidenceItem => ({
  claim: "c",
  id,
  quote: "q",
  sourceId,
  verified,
});
const sources = [
  src("s1", "https://www.stat.example/report", "The 2025 Report"),
  src("s2", "https://other.example/a"),
  src("s3", "https://third.example/b"),
];
const evidence = [ev("c1", "s1"), ev("c2", "s2"), ev("c3", "s3"), ev("c4", "s1"), ev("c5", "s1", false)];

test("the marker regex matches ids", () => {
  expect([..."a {{c:c1}} b {{c:x_2}}".matchAll(CITATION_MARKER_RE)].map((m) => m[1])).toEqual(["c1", "x_2"]);
});

test("references: superscripts after punctuation, numbered by first appearance, one Sources list", () => {
  const out = renderCitations("One {{c:c2}}. Two {{c:c1}} {{c:c4}}. Three{{c:c3}}.", evidence, sources, "references", "en");
  expect(out).toContain("One.[¹](https://other.example/a)");
  expect(out).toContain("Two.[²](https://www.stat.example/report)");
  expect(out).toContain("Three.[³]");
  expect(out).toContain("\n## Sources\n");
  expect(out).toContain("2. [The 2025 Report](https://www.stat.example/report) — stat.example");
  expect(out).toContain("1. [other.example](https://other.example/a)");
});

test("references: an unknown locale falls back to Sources, and an old Sources section is replaced", () => {
  const out = renderCitations("A {{c:c1}}.\n\n## Sources\n\n1. old", evidence, sources, "references", "lv");
  expect(out.match(/## Sources/g)?.length).toBe(1);
  expect(out).not.toContain("old");
});

test("inline: [host](url) after the sentence, no list", () => {
  const out = renderCitations("A claim {{c:c1}}{{c:c2}}.", evidence, sources, "inline", "en");
  expect(out).toBe("A claim. [stat.example](https://www.stat.example/report), [other.example](https://other.example/a)");
  expect(out).not.toContain("## Sources");
});

test("unverified, unknown and unsafe-URL runs are left as written and reported", () => {
  const bad = [src("b", "javascript:alert(1)")];
  const r = renderCitationsDetailed(
    "A {{c:c5}}. B {{c:zz}}. C {{c:cb}}.",
    [...evidence, ev("cb", "b")],
    [...sources, ...bad],
    "references",
    "en"
  );
  expect(r.unresolved.sort()).toEqual(["c5", "cb", "zz"]);
  expect(r.markdown).toContain("{{c:c5}}");
  expect(r.markdown).not.toContain("## Sources");
});

test("markers in code or link text are not rendered", () => {
  const r = renderCitationsDetailed("Use `x {{c:c1}}` and [see {{c:c2}}](https://a.example).\n\n```\n{{c:c3}}\n```\n", evidence, sources, "inline", "en");
  expect(r.unresolved.sort()).toEqual(["c1", "c2", "c3"]);
});

test("a source URL with parens or spaces cannot bend the link", () => {
  const s = [src("w", "https://w.example/a_(b) c")];
  const out = renderCitations("A {{c:w1}}.", [ev("w1", "w")], s, "inline", "en");
  expect(out).toContain("(https://w.example/a_%28b%29%20c)");
});
