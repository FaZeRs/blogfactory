import { expect, test } from "bun:test";
import { fakeCtx } from "../test-helpers.js";
import { briefStage, linkCandidates, serpText, type BriefInput } from "./index.js";
import { PLAN, fitLengthPlan, planTarget, validateBrief, type Brief } from "./schema.js";

const input: BriefInput = {
  topic: "solar panels",
  locale: "en",
  sourceType: "article_keyword",
  voice: "",
  evidence: ["c1", "c2", "c3"].map((id) => ({ id, claim: `claim ${id} here`, quote: "q", url: `https://a.example/${id}` })),
  links: [{ url: "https://blog.example/post-a", title: "Post A" }],
  keywordData: false,
  minClaims: 3,
};
const good = (over: Partial<Brief> = {}): Brief => ({
  angle: "A practical look at what solar costs a small site",
  primaryKeyword: "solar panels",
  titleOptions: ["Solar panels explained", "Solar panels for small sites", "What solar panels cost"],
  chosenTitle: "Solar panels explained",
  description: "Learn what solar panels cost and what they return.",
  outline: Array.from({ length: 5 }, (_, i) => ({ heading: `Section ${i + 1}`, purpose: "Explain this part of the topic", claimIds: [["c1", "c2", "c3"][i % 3]!], words: 320 })),
  faq: [1, 2, 3].map((i) => ({ question: `Question number ${i}?`, answerPoints: ["point"] })),
  takeaways: ["One plain takeaway sentence.", "Two plain takeaway sentence.", "Three plain takeaway sentence."],
  internalLinks: [{ url: "https://blog.example/post-a", anchorText: "Post A" }],
  ...over,
});
const check = { verifiedIds: new Set(["c1", "c2", "c3"]), links: new Set(["https://blog.example/post-a"]), minClaims: 3 };

test("a valid brief has no issues and fitLengthPlan keeps it in band", () => {
  expect(validateBrief(fitLengthPlan(good()), check)).toEqual([]);
  const huge = fitLengthPlan(good({ outline: good().outline.map((s) => ({ ...s, words: 900 })) }));
  const total = PLAN.openingWords + PLAN.faqWordsEach * 3 + huge.outline.reduce((n, s) => n + s.words, 0);
  expect(total).toBeLessThanOrEqual(PLAN.limits.max);
});

test("links outside the index and unknown claim ids are issues", () => {
  const issues = validateBrief(good({ internalLinks: [{ url: "https://evil.example/", anchorText: "xx" }], outline: good().outline.map((s) => ({ ...s, claimIds: ["c9"] })) }), check);
  expect(issues.some((i) => i.includes("not in the candidate list"))).toBe(true);
  expect(issues.some((i) => i.includes("unknown or unverified claim"))).toBe(true);
});

test("one repair round: the second reply is used and keyword data is not requested", async () => {
  const bad = good({ internalLinks: [{ url: "https://evil.example/", anchorText: "xx" }] });
  const { ctx, llm } = fakeCtx({ llm: { brief: [bad, good()] } });
  const out = await briefStage.run(input, ctx);
  expect(out.output.internalLinks[0]?.url).toBe("https://blog.example/post-a");
  expect(llm.calls).toHaveLength(2);
  expect(llm.calls[1]?.user).toContain("not in the candidate list");
});

test("two invalid replies fail the stage", async () => {
  const bad = good({ internalLinks: [{ url: "https://evil.example/", anchorText: "xx" }] });
  const { ctx } = fakeCtx({ llm: { brief: [bad, bad] } });
  await expect(briefStage.run(input, ctx)).rejects.toThrow("brief failed validation twice");
});

test("deep mode looks the keyword up once; it lands in the output", async () => {
  let calls = 0;
  const dataForSeo = { serp: async () => [], peopleAlsoAsk: async () => [], keywordIdeas: async () => [], keywordOverview: async (keyword: string) => { calls += 1; return { keyword, volume: 900, difficulty: 30, intent: "informational", aiOverview: false }; } };
  const { ctx } = fakeCtx({ llm: { brief: [good()] }, dataForSeo });
  const out = await briefStage.run({ ...input, keywordData: true }, ctx);
  expect(calls).toBe(1);
  expect(out.output.keywordData?.volume).toBe(900);
});

test("deep mode falls back to the chosen keyword when the topic has no search data", async () => {
  const asked: string[] = [];
  const dataForSeo = { serp: async () => [], peopleAlsoAsk: async () => [], keywordIdeas: async () => [], keywordOverview: async (keyword: string) => {
    asked.push(keyword);
    return asked.length === 1 ? null : { keyword, volume: 4400, difficulty: 31, intent: "commercial", aiOverview: false };
  } };
  const { ctx } = fakeCtx({ llm: { brief: [good()] }, dataForSeo });
  const out = await briefStage.run({ ...input, topic: "how to pick solar panels for a small roof", keywordData: true }, ctx);
  expect(asked).toEqual(["how to pick solar panels for a small roof", good().primaryKeyword]);
  expect(out.output.keywordData?.volume).toBe(4400);
});

test("link candidates come from the index only, deduped", () => {
  expect(linkCandidates({ internalLinkIndex: { pages: [{ url: "https://s.example/a", title: "A" }, { url: "https://s.example/a", title: "A2" }, { title: "no url" }] } })).toEqual([{ url: "https://s.example/a", title: "A" }]);
  expect(linkCandidates({})).toEqual([]);
});

test("planTarget clamps typical length into the plan band and fitLengthPlan scales to it", () => {
  expect(planTarget(null)).toBeNull();
  expect(planTarget(100)).toBe(PLAN.limits.min);
  expect(planTarget(99_999)).toBe(PLAN.limits.max);
  const target = planTarget(1800)!;
  const fitted = fitLengthPlan(good(), target);
  const total = PLAN.openingWords + PLAN.faqWordsEach * 3 + fitted.outline.reduce((n, s) => n + s.words, 0);
  expect(Math.abs(total - target)).toBeLessThanOrEqual(fitted.outline.length);
});

test("serpText lists gaps, information gain and the target; empty input is None", () => {
  expect(serpText(null)).toBe("None.");
  const t = serpText({ searchIntent: "i", coveredTopics: ["a"], gaps: ["g1"], informationGain: [{ point: "p", claimIds: ["c1"] }], typicalLength: 1800 }, ["Q?"], 1800);
  expect(t).toContain("- g1");
  expect(t).toContain("p [c1]");
  expect(t).toContain("- Q?");
  expect(t).toContain("about 1800 words");
});
