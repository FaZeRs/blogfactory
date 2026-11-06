import { expect, test } from "bun:test";
import { loadPrompt } from "../../prompts/load.js";
import type { BriefOutput } from "../brief/schema.js";
import { fakeCtx } from "../test-helpers.js";
import { classify, matchesPlan, normalizeForMatch, reviewDraft, type ReviewInput, factcheckBlocks } from "./index.js";

const brief: BriefOutput = {
  angle: "A calm plan for small teams that want solar without surprises",
  primaryKeyword: "solar for small teams",
  titleOptions: ["Solar for small teams", "Solar planning", "Small team solar"],
  chosenTitle: "Solar for small teams",
  description: "d".repeat(40),
  outline: [{ heading: "Size the battery", purpose: "Explain how evening use decides the battery size", claimIds: ["c1"], words: 300 }],
  faq: [{ question: "Who should check the roof before an installation?", answerPoints: ["installer"] }],
  takeaways: ["A takeaway sentence."],
  internalLinks: [],
  keywordData: null,
};
const raw = "Teams that track bills find savings early {{c:c1}}.\n\nThe battery “pays off” only with evening use — mostly.\n\nRoofs are always safe.";
const input: ReviewInput = {
  locale: "en", voice: "", brief, citationStyle: "references",
  evidence: [{ id: "c1", claim: "Teams save early.", quote: "q", url: "https://a.example/1" }],
  sources: [], evidenceSources: {},
  draft: { title: "Solar for small teams", description: "d".repeat(40), markdown: raw, citedClaimIds: ["c1"], unresolvedMarkers: [], words: 20 },
  previousBlockers: null,
  reviseCount: 0,
};
const factReply = (...kinds: string[]) => ({ issues: kinds.map((kind) => ({ kind, excerpt: "Roofs are always safe.", claimId: "c1", fix: "Cite or remove." })) });

test("normalizeForMatch ignores case, whitespace, curly quotes, dashes and markers", () => {
  expect(normalizeForMatch(raw)).toContain('the battery "pays off" only with evening use - mostly.');
  expect(normalizeForMatch("Teams that  track bills find savings early.")).toBe("teams that track bills find savings early.");
});

test("classify drops excerpts that are not in the draft and counts them", () => {
  const issues = [
    { kind: "unsupported", excerpt: "the battery \"PAYS OFF\" only with evening use - mostly.", fix: "f" },
    { kind: "unsupported", excerpt: "A sentence the model made up.", fix: "f" },
    { kind: "unsupported", excerpt: "  ", fix: "f" },
  ];
  const { found, dropped } = classify("factcheck", issues, raw, brief);
  expect(found).toHaveLength(1);
  expect(dropped).toBe(2);
});

test("classify caps issues per check at 8 and 6", () => {
  const many = (n: number, kind: string) => Array.from({ length: n }, () => ({ kind, excerpt: "Roofs are always safe.", fix: "f" }));
  expect(classify("factcheck", many(20, "overstated"), raw, brief).found).toHaveLength(8);
  expect(classify("reader", many(20, "padding"), raw, brief).found).toHaveLength(6);
});

test("fact-check severity: contradictions, cited unsupported claims and unsourced numbers block; the rest are notes", () => {
  const sev = (kind: string) => classify("factcheck", factReply(kind).issues, raw, brief).found[0]?.blocker;
  expect(sev("unsupported")).toBe(true);
  expect(sev("contradiction")).toBe(true);
  expect(sev("overstated")).toBe(false);
  expect(factcheckBlocks({ kind: "uncited_fact", excerpt: "You might save 10-15 minutes per order." })).toBe(true);
  expect(factcheckBlocks({ kind: "uncited_fact", excerpt: "Most tools offer a free trial." })).toBe(false);
  expect(factcheckBlocks({ kind: "unsupported", excerpt: "Most tools offer a free trial." })).toBe(false);
  expect(factcheckBlocks({ kind: "unsupported", excerpt: "Teams save hours{{c:c2}}." })).toBe(true);
  expect(factcheckBlocks({ kind: "unsupported", excerpt: "Teams save hours.", claimId: "c2" })).toBe(true);
});

test("reader severity: missing_step and unanswered_question block only when they match the plan", () => {
  const issue = (kind: string, fix: string) => classify("reader", [{ kind, excerpt: "Roofs are always safe.", fix }], raw, brief).found[0]?.blocker;
  expect(issue("unanswered_question", "Answer who should check the roof before an installation")).toBe(true);
  expect(issue("missing_step", "Explain how evening use decides the battery size")).toBe(true);
  expect(issue("missing_step", "Add a step about permits")).toBe(false);
  expect(issue("unclear", "Who should check the roof before an installation")).toBe(false);
  expect(issue("padding", "Explain how evening use decides the battery size")).toBe(false);
  expect(matchesPlan("nothing relevant", ["Size the battery"])).toBe(false);
  expect(matchesPlan("Explain what this means for your team", ["Explain what solar costs and how your team pays for it"])).toBe(false);
});

test("mode gating: normal runs the fact-check only, deep also the reader; both use the review role", async () => {
  const normal = fakeCtx({ llm: { review: [{ issues: [] }] } });
  await reviewDraft(input, normal.ctx);
  expect(normal.llm.calls.map((c) => c.role)).toEqual(["review"]);
  expect(normal.llm.calls[0]?.system).toContain("fact-checker");

  const deep = fakeCtx({ mode: "deep", llm: { review: [{ issues: [] }, { issues: [] }] } });
  await reviewDraft(input, deep.ctx);
  expect(deep.llm.calls.map((c) => c.role)).toEqual(["review", "review"]);
  expect(deep.llm.calls[1]?.user).toContain("solar for small teams");
});

test("no blockers delivers; the output carries the dropped count and the warning", async () => {
  const { ctx } = fakeCtx({ llm: { review: [{ issues: [...factReply("overstated").issues, { kind: "unsupported", excerpt: "not in the draft", fix: "f" }] }] } });
  const { outcome, rows } = await reviewDraft(input, ctx);
  expect(outcome.next).toEqual({ type: "advance", to: "deliver" });
  expect(outcome.output).toMatchObject({ passed: true, escalated: false, blockerCount: 0, warningCount: 1, dropped: 1, blockers: [] });
  expect(rows.map((r) => [r.gate, r.found.length, r.dropped])).toEqual([["factcheck", 1, 1]]);
});

test("blockers with revise loops left go to revise; blockers carry gate, message, excerpt and fix", async () => {
  const { ctx } = fakeCtx({ llm: { review: [factReply("unsupported")] } });
  const { outcome } = await reviewDraft(input, ctx);
  expect(outcome.next).toEqual({ type: "advance", to: "revise" });
  expect(outcome.output.blockers).toEqual([{ gate: "factcheck", message: "Claim is not supported by the evidence", excerpt: "Roofs are always safe.", fix: "Cite or remove." }]);
  expect(outcome.output.escalated).toBe(false);
});

test("a review that did not shrink the previous blocker list stops and escalates", async () => {
  const { ctx } = fakeCtx({ llm: { review: [factReply("unsupported")] } });
  const { outcome } = await reviewDraft({ ...input, previousBlockers: 1 }, ctx);
  expect(outcome.next).toEqual({ type: "advance", to: "deliver" });
  expect(outcome.output.escalated).toBe(true);
  expect(outcome.output.reason).toStartWith("Review still failing: factcheck:");
});

test("spent revise loops escalate too; a shrinking list still revises", async () => {
  const spent = fakeCtx({ llm: { review: [factReply("unsupported")] } });
  expect((await reviewDraft({ ...input, reviseCount: 2 }, spent.ctx)).outcome.next).toEqual({ type: "advance", to: "deliver" });
  const shrinking = fakeCtx({ mode: "deep", llm: { review: [factReply("unsupported"), { issues: [] }] } });
  expect((await reviewDraft({ ...input, reviseCount: 1, previousBlockers: 3 }, shrinking.ctx)).outcome.next).toEqual({ type: "advance", to: "revise" });
});

test("the review prompts have every variable they need and fence untrusted text", async () => {
  const f = await loadPrompt("review-factcheck");
  expect(f.user).toContain("{{evidence}}");
  expect(f.user).toContain("{{draft}}");
  const r = await loadPrompt("review-reader");
  expect(r.user).toContain("{{plan}}");
  expect(r.system).toContain("{{dataRule}}");
});
