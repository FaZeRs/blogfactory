import { expect, test } from "bun:test";
import { fakeCtx } from "../test-helpers.js";
import { briefStage, linkCandidates, serpText, type BriefInput } from "./index.js";
import { BriefModelSchema, PLAN, fitLengthPlan, planTarget, repairBrief, validateBrief, type Brief } from "./schema.js";

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
  const dataForSeo = { serp: async () => [], peopleAlsoAsk: async () => [], keywordIdeas: async () => [], relatedKeywords: async () => [], keywordOverview: async (keyword: string) => { calls += 1; return { keyword, volume: 900, difficulty: 30, intent: "informational", aiOverview: false }; } };
  const { ctx } = fakeCtx({ llm: { brief: [good()] }, dataForSeo });
  const out = await briefStage.run({ ...input, keywordData: true }, ctx);
  expect(calls).toBe(1);
  expect(out.output.keywordData?.volume).toBe(900);
});

test("deep mode falls back to the chosen keyword when the topic has no search data", async () => {
  const asked: string[] = [];
  const dataForSeo = { serp: async () => [], peopleAlsoAsk: async () => [], keywordIdeas: async () => [], relatedKeywords: async () => [], keywordOverview: async (keyword: string) => {
    asked.push(keyword);
    return asked.length === 1 ? null : { keyword, volume: 4400, difficulty: 31, intent: "commercial", aiOverview: false };
  } };
  const { ctx } = fakeCtx({ llm: { brief: [good()] }, dataForSeo });
  const out = await briefStage.run({ ...input, topic: "how to pick solar panels for a small roof", keywordData: true }, ctx);
  expect(asked).toEqual(["how to pick solar panels for a small roof", good().primaryKeyword]);
  expect(out.output.keywordData?.volume).toBe(4400);
});

test("related searches reach the prompt; secondary keywords outside them are dropped", async () => {
  const kw = (keyword: string, volume: number | null) => ({ keyword, volume, difficulty: null, intent: null, aiOverview: false });
  const dataForSeo = { serp: async () => [], peopleAlsoAsk: async () => [], keywordOverview: async () => null, keywordIdeas: async () => [],
    relatedKeywords: async () => [kw("solar panels", 9000), kw("solar panel cost", 2400), kw("best solar panels", 5000), kw("Solar Panel Cost", 10), kw("vps hosting", 8100)] };
  const { ctx, llm } = fakeCtx({ llm: { brief: [good({ secondaryKeywords: ["best solar panels", " solar panel cost", "Solar Panel COST", "made up phrase"] })] }, dataForSeo });
  const out = await briefStage.run({ ...input, keywordData: true }, ctx);
  expect(llm.calls[0]?.user).toContain("- best solar panels (5000)\n- solar panel cost (2400)");
  expect(llm.calls[0]?.user).not.toContain("- solar panels (9000)");
  expect(llm.calls[0]?.user).not.toContain("vps hosting");
  expect(out.output.secondaryKeywords).toEqual(["best solar panels", "solar panel cost"]);
  expect(out.output.relatedKeywords).toEqual([{ keyword: "best solar panels", volume: 5000 }, { keyword: "solar panel cost", volume: 2400 }]);
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

test("repairBrief fixes near misses in titles and the description; a fixed brief validates", () => {
  const long = "A title that is clearly longer than the sixty character limit allows";
  const desc = `${"Learn what solar panels cost a small site, what they return each year, ".repeat(2)}and how to pick one now.`;
  expect(desc.length).toBeGreaterThan(155);
  const fixed = repairBrief(good({ titleOptions: [...good().titleOptions, long], chosenTitle: "Solar panels, simply", description: desc }));
  expect(fixed.titleOptions).toEqual(["Solar panels, simply", ...good().titleOptions]);
  expect(fixed.description.length).toBeLessThanOrEqual(155);
  expect(validateBrief(fixed, check)).toEqual([]);
  expect(repairBrief(good({ chosenTitle: long })).chosenTitle).toBe(good().titleOptions[0]);
  expect(repairBrief(good())).toEqual(good());
  // Five options plus a missing chosen title stays within the schema's five.
  const five = ["Option one here", "Option two here", "Option three here", "Option four here", "Option five here"];
  const capped = repairBrief(good({ titleOptions: five, chosenTitle: "Solar panels, simply" }));
  expect(capped.titleOptions).toEqual(["Solar panels, simply", ...five.slice(0, 4)]);
  expect(BriefModelSchema.safeParse(capped).success).toBe(true);
});

test("the editor's direction and, on a refresh, the current article reach the brief prompt; a new article says so", async () => {
  const refresh = fakeCtx({ llm: { brief: [good()] } });
  await briefStage.run({ ...input, guidance: "Angle: Keep what still holds", current: "Title: Old post\n\nOld body text." }, refresh.ctx);
  const user = refresh.llm.calls[0]!.user;
  expect(user).toContain("Keep what still holds");
  expect(user).toContain("Old body text.");
  const fresh = fakeCtx({ llm: { brief: [good()] } });
  await briefStage.run(input, fresh.ctx);
  expect(fresh.llm.calls[0]!.user).toContain("None: this is a new article.");
});
