import { describe, expect, test } from "bun:test";
import { claimIdsByEvidence, stageDetails } from "./run-view.js";

describe("stageDetails", () => {
  test("keeps article text out of draft details", () => {
    const d = stageDetails("draft", { output: { title: "T", words: 1800, markdown: "secret body" } });
    expect(d).toEqual({ title: "T", words: 1800 });
  });

  test("summarises the brief without answer points", () => {
    const d = stageDetails("brief", {
      output: {
        chosenTitle: "T", angle: "A", outline: [{ heading: "H", purpose: "P", words: 200, claimIds: ["c1"], extra: 1 }],
        faq: [{ question: "Q?", answerPoints: ["x"] }], internalLinks: [{ url: "/a", anchorText: "a" }],
      },
    });
    expect(d?.outline).toEqual([{ heading: "H", purpose: "P", words: 200, claimIds: ["c1"] }]);
    expect(d?.faq).toEqual(["Q?"]);
  });

  test("review reports the gates shape plus the dropped count", () => {
    const d = stageDetails("review", { output: { passed: false, blockerCount: 1, warningCount: 0, blockers: [], dropped: 2, escalated: false, reason: null, extra: 1 } });
    expect(d).toMatchObject({ blockerCount: 1, dropped: 2 });
    expect(d).not.toHaveProperty("extra");
  });

  test("returns null for empty or unknown output", () => {
    expect(stageDetails("research", null)).toBeNull();
    expect(stageDetails("gates", { output: {} })).toBeNull();
  });
});

test("claimIdsByEvidence maps evidence ids to claim ids", () => {
  const m = claimIdsByEvidence({ output: { claims: [{ claimId: "c1", evidenceId: "e1" }, { claimId: 2 }] } });
  expect([...m]).toEqual([["e1", "c1"]]);
});

test("research details include competitors, questions and the analysis", () => {
  const d = stageDetails("research", { output: { queries: ["q"], claims: [{ claimId: "c1" }], questions: ["Q?"], competitors: [{ url: "https://a.example", title: "T", words: 900, outline: [{ level: 2, text: "H" }], extra: 1 }], serpAnalysis: { searchIntent: "i", gaps: ["g"], typicalLength: 900 } } });
  expect(d?.competitors).toEqual([{ url: "https://a.example", title: "T", words: 900, outline: [{ level: 2, text: "H" }] }]);
  expect(d?.questions).toEqual(["Q?"]);
  expect((d?.serpAnalysis as { gaps: string[] }).gaps).toEqual(["g"]);
  expect(d).not.toHaveProperty("claims");
});
