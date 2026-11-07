import { expect, test } from "bun:test";
import { fakeCtx } from "../test-helpers.js";
import { analyzeSerp, competitorOutline, serpQuestions } from "./competitors.js";
import { diverseUrls, normalizeUrl, researchCore, type ResearchInput } from "./index.js";
import { SerpAnalysisSchema } from "./schema.js";

const input: ResearchInput = { topic: "solar panels", sourceType: "article_keyword", locale: "en", maxQueries: 3, maxPages: 5, maxClaimsPerPage: 5, minVerifiedClaims: 3 };
const QUOTE = "Solar capacity grew by forty percent across the member states during the last full reporting year according to the agency";
const PAGE = `# Report\n\n${QUOTE}.\n\n${"Filler sentence about energy markets and policy. ".repeat(20)}`;

test("normalizeUrl strips tracking, hash and credentials", () => {
  expect(normalizeUrl("https://u:p@a.example/x/?utm_source=z&b=1#h")).toBe("https://a.example/x/?b=1");
  expect(normalizeUrl("ftp://a.example")).toBeNull();
});

test("diverseUrls takes hits round-robin across queries, at most two per site", () => {
  const a = ["https://a.test/1", "https://www.a.test/2", "https://a.test/3", "https://b.test/1"];
  const b = ["https://c.test/1", "https://a.test/1", "https://d.test/1"];
  expect(diverseUrls([a, b])).toEqual(["https://a.test/1", "https://c.test/1", "https://www.a.test/2", "https://d.test/1", "https://b.test/1"]);
  expect(diverseUrls([])).toEqual([]);
});

test("verifies quotes against the page, skips unreadable URLs and dedupes redirects", async () => {
  const { ctx } = fakeCtx({
    llm: {
      research_queries: [{ queries: ["solar growth statistics", "solar policy"] }],
      research_claims: [{ claims: [
        { claim: "Solar capacity grew by forty percent.", kind: "statistic", quote: QUOTE },
        { claim: "Invented figure of ninety percent.", kind: "statistic", quote: "This sentence never appeared on the page at all in any form whatsoever ok" },
      ] }],
    },
    search: {
      "solar growth statistics": [
        { url: "https://a.example/report?utm_source=x", title: "Report", snippet: "" },
        { url: "http://127.0.0.1/private", title: "Private", snippet: "" },
      ],
      "solar policy": [{ url: "https://a.example/report", title: "Dup", snippet: "" }],
    },
    pages: { "https://a.example/report": { markdown: PAGE, title: "Report", fetchedAt: new Date("2026-11-03T00:00:00Z") } },
  });
  // The reader throws on non-public URLs; the stage must skip that URL.
  const read = ctx.deps.reader.read.bind(ctx.deps.reader);
  ctx.deps.reader.read = async (url, signal) => {
    if (url.includes("127.0.0.1")) throw new Error("not public");
    return read(url, signal);
  };
  const result = await researchCore(input, ctx);
  expect(result.sources.map((s) => s.finalUrl)).toEqual(["https://a.example/report"]);
  expect(result.rows.map((r) => r.verified)).toEqual([true, false]);
  expect(result.rows[1]?.reason).toBe("quote-not-found");
  expect(result.skipped).toBe(0);
});

test("a page whose extraction fails is skipped; all failing rethrows", async () => {
  const { ctx } = fakeCtx({
    llm: { research_queries: [{ queries: ["solar a", "solar b"] }], research_claims: [{ claims: "bad" }] },
    search: { "solar a": [{ url: "https://a.example/report", title: "R", snippet: "" }] },
    pages: { "https://a.example/report": { markdown: PAGE } },
  });
  await expect(researchCore(input, ctx)).rejects.toThrow();
});

test("competitorOutline reads title, H2/H3 outline and words; ignores headings in code fences", () => {
  const md = "# The Title\n\nSome words here.\n\n## First **bold** [link]\n\n### Sub one\n\n```\n## not a heading\n```\n\n#### Too deep\n\n## Second ##\n";
  const o = competitorOutline(md);
  expect(o.title).toBe("The Title");
  expect(o.outline).toEqual([{ level: 2, text: "First bold link" }, { level: 3, text: "Sub one" }, { level: 2, text: "Second" }]);
  expect(o.words).toBeGreaterThan(5);
});

test("serpQuestions collects question spans from titles and snippets", () => {
  expect(serpQuestions([{ url: "u", title: "How much do panels cost?", snippet: "Prices vary. Is solar worth it? Read on." }])).toEqual(["How much do panels cost?", "Is solar worth it?"]);
});

const ANALYSIS = { searchIntent: "Learn what solar costs", coveredTopics: ["Costs"], gaps: ["Battery sizing for small offices"], informationGain: [{ point: "Battery sizing follows evening use", claimIds: ["c1", "c9"] }] };
const comp = { topic: "solar panels", locale: "en", maxCompetitors: 2, siteDomain: "own.example", claims: [{ id: "c1", claim: "A claim" }], deep: false };

test("analyzeSerp skips the site's own domain, outlines competitors and returns the analysis with a median length", async () => {
  const page = (n: number) => ({ markdown: `# P${n}\n\n## Costs\n\n${"word ".repeat(300 * n)}` });
  const { ctx } = fakeCtx({
    llm: { research_claims: [ANALYSIS] },
    search: { "solar panels": ["https://own.example/a", "https://www.own.example/b", "https://c1.example/x", "https://c2.example/y", "https://c3.example/z"].map((url) => ({ url, title: "Does it pay off?", snippet: "" })) },
    pages: { "https://c1.example/x": page(1), "https://c2.example/y": page(2), "https://c3.example/z": page(3) },
  });
  const spent: never[] = [];
  const r = await analyzeSerp(comp, ctx, spent);
  expect(r.competitors.map((c) => c.url)).toEqual(["https://c1.example/x", "https://c2.example/y"]);
  expect(r.questions).toEqual(["Does it pay off?"]);
  expect(r.serpAnalysis?.informationGain[0]?.claimIds).toEqual(["c1"]);
  expect(r.serpAnalysis?.typicalLength).toBeGreaterThan(300);
  expect(SerpAnalysisSchema.safeParse(r.serpAnalysis).success).toBe(true);
});

test("analyzeSerp without results or with failing reads returns no analysis instead of throwing", async () => {
  const none = fakeCtx({ search: {} });
  expect((await analyzeSerp(comp, none.ctx, [])).serpAnalysis).toBeNull();
  const bad = fakeCtx({ search: { "solar panels": [{ url: "https://c1.example/x", title: "t", snippet: "" }] }, pages: {} });
  expect((await analyzeSerp(comp, bad.ctx, [])).competitors).toEqual([]);
  const failing = fakeCtx({ llm: { research_claims: [{ nope: 1 }] }, search: { "solar panels": [{ url: "https://c1.example/x", title: "t", snippet: "" }] }, pages: { "https://c1.example/x": { markdown: `# T\n\n${"word ".repeat(300)}` } } });
  expect((await analyzeSerp(comp, failing.ctx, [])).serpAnalysis).toBeNull();
});
