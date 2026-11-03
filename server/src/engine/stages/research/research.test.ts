import { expect, test } from "bun:test";
import { fakeCtx } from "../test-helpers.js";
import { normalizeUrl, researchCore, type ResearchInput } from "./index.js";

const input: ResearchInput = { topic: "solar panels", sourceType: "article_keyword", locale: "en", maxQueries: 3, maxPages: 5, maxClaimsPerPage: 5, minVerifiedClaims: 3 };
const QUOTE = "Solar capacity grew by forty percent across the member states during the last full reporting year according to the agency";
const PAGE = `# Report\n\n${QUOTE}.\n\n${"Filler sentence about energy markets and policy. ".repeat(20)}`;

test("normalizeUrl strips tracking, hash and credentials", () => {
  expect(normalizeUrl("https://u:p@a.example/x/?utm_source=z&b=1#h")).toBe("https://a.example/x/?b=1");
  expect(normalizeUrl("ftp://a.example")).toBeNull();
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
