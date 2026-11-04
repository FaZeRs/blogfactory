import { expect, test } from "bun:test";
import { createFakeLlm } from "../adapters/fake-llm.js";
import { MODE_PRESETS } from "../modes.js";
import { generateArticleForEval, runEval, type ChatFn } from "./run.js";
import { frozenEvidence, loadEvalBriefs, type EvalBrief } from "./schema.js";

const brief = (await loadEvalBriefs())[0] as EvalBrief;

const plan = {
  angle: "Most order emails follow a pattern, so a person can keep the final say",
  primaryKeyword: "order email automation",
  titleOptions: ["Order emails into spreadsheet rows", "Trusting rows built from emails", "Checking order rows by hand"],
  chosenTitle: "Order emails into spreadsheet rows",
  description: "How a small team turns order emails into spreadsheet rows.",
  outline: Array.from({ length: 5 }, (_, i) => ({ heading: `Section ${i + 1}`, purpose: "Explain this part of the topic", claimIds: [["c1", "c2", "c3"][i % 3]!], words: 320 })),
  faq: [1, 2, 3].map((i) => ({ question: `Question number ${i}?`, answerPoints: ["point"] })),
  takeaways: ["One plain takeaway sentence.", "Two plain takeaway sentence.", "Three plain takeaway sentence."],
  internalLinks: [],
};
const article = `Opening paragraph about the topic {{c:c1}}.\n\n## First\n\n${"Plain filler sentence for the draft body. ".repeat(60)}\n\nAnother claim {{c:c2}}.`;
const written = { title: "Ignored", description: "A description that is long enough.", markdown: article, citedClaimIds: ["c1", "c2"] };
const rubric = { accuracy: 8, clarity: 7, note: "n", specificity: 6, usefulness: 7, voice: 7 };

const chat: ChatFn & { calls: Parameters<ChatFn>[0][] } = Object.assign(
  async (req: Parameters<ChatFn>[0]) => {
    chat.calls.push(req);
    return { text: `# A plain fast title\n\n${"A sentence from the fast writer. ".repeat(80)}`, costUsd: 0.01 };
  },
  { calls: [] as Parameters<ChatFn>[0][] },
);

test("one brief x two modes: a report with both modes and a pairwise result", async () => {
  const llm = createFakeLlm({
    brief: [plan],
    draft: [written],
    revise: [written],
    judge: [rubric, rubric, { reason: "r", winner: "tie" }],
  });
  const report = await runEval([brief], ["fast", "normal"], { llm, chat, judgeModel: "judge/model" }, { fastModel: "writer/model" });
  expect(report.baseline).toBe("fast");
  expect(Object.keys(report.briefs[0]!.results).sort()).toEqual(["fast", "normal"]);
  expect(report.briefs[0]!.results.fast!.pairwise).toBeUndefined();
  expect(report.briefs[0]!.results.normal!.error).toBeUndefined();
  expect(report.briefs[0]!.results.normal!.pairwise).toBe("tie");
  expect(report.lines).toEqual(["normal vs fast: 0-0-1"]);
  expect(report.summary.normal!.pairwise).toEqual({ wins: 0, losses: 0, ties: 1 });
  expect(report.summary.fast!.costUsd).toBe(0.01);
  expect(report.briefs[0]!.results.normal!.failedGates.length).toBeGreaterThan(0);
  // The fast baseline sends the writer prompt and the keyword message with the brief's topic, and no evidence.
  expect(chat.calls[0]!.model).toBe("writer/model");
  expect(chat.calls[0]!.system).toContain("senior blog writer");
  expect(chat.calls[0]!.user).toContain(brief.topic);
  // The engine drafted from the engine mode's own writer model.
  expect(llm.calls.find((c) => c.role === "draft")!.model).toBe(MODE_PRESETS.normal.models.draft);
  expect(llm.calls.filter((c) => c.role === ("judge" as never))).toHaveLength(3);
});

test("a mode that cannot generate is scored as a failure and loses the pair", async () => {
  const llm = createFakeLlm({ judge: [rubric] });
  const weak: EvalBrief = { ...brief, evidence: brief.evidence.map((e) => ({ ...e, quote: "words that never appear in the frozen source page at all today" })) };
  const report = await runEval([weak], ["fast", "normal"], { llm, chat, judgeModel: "j" }, { fastModel: "m" });
  const normal = report.briefs[0]!.results.normal!;
  expect(normal.error).toContain("verified claims");
  expect(normal.pairwise).toBe("loss");
  expect(report.summary.normal!.failures).toBe(1);
  expect(report.lines).toEqual(["normal vs fast: 0-1-0"]);
  expect(report.summary.normal!.decision!.apply).toBe(false);
});

test("fast generation reads the title from the H1 and runs the gates without evidence", async () => {
  const out = await generateArticleForEval(brief, "m", { chat });
  expect(out.title).toBe("A plain fast title");
  expect(out.markdown.startsWith("A sentence")).toBe(true);
  expect(out.failedGates).toContain("citations");
});

test("every shipped brief has at least three claims that verify against their frozen sources", async () => {
  for (const b of await loadEvalBriefs()) {
    expect(frozenEvidence(b, new Date()).evidence.filter((e) => e.verified).length).toBeGreaterThanOrEqual(3);
  }
});

test("recorded briefs get an ASCII id one past the highest number, and keep only verified claims", async () => {
  const { nextBriefId, briefFromResearch } = await import("./record.js");
  expect(nextBriefId(["01-a.json", "10-b.json"], "Diş hekimi fiyatları İstanbul")).toBe("11-dis-hekimi-fiyatlari-istanbul");
  const src = { url: "https://a.example/x", finalUrl: "https://a.example/x", title: null, markdown: "page text", status: 200, fetchedVia: "safe-fetch", fetchedAt: new Date(0) };
  const row = (verified: boolean, sourceIndex: number) => ({ sourceIndex, claim: "claim text here", quote: "quote text here", kind: "fact", verified, method: null, ratio: null, reason: null });
  const b = briefFromResearch("11-x", "topic here", "tr", { queries: [], skipped: 0, sources: [src, { ...src, finalUrl: "https://b.example/y" }], rows: [row(true, 0), row(true, 0), row(true, 0), row(false, 1)] });
  expect(b.sources.map((s) => s.url)).toEqual(["https://a.example/x"]);
  expect(b.evidence).toHaveLength(3);
});
