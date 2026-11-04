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

  test("returns null for empty or unknown output", () => {
    expect(stageDetails("research", null)).toBeNull();
    expect(stageDetails("gates", { output: {} })).toBeNull();
  });
});

test("claimIdsByEvidence maps evidence ids to claim ids", () => {
  const m = claimIdsByEvidence({ output: { claims: [{ claimId: "c1", evidenceId: "e1" }, { claimId: 2 }] } });
  expect([...m]).toEqual([["e1", "c1"]]);
});
