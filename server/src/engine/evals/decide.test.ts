import { expect, test } from "bun:test";
import { decideRules } from "./decide.js";
import { candidateFirst, summarize, type EvalDraft } from "./run.js";

const v = (gate: number, mean: number, dims: Partial<Record<string, number>> = {}) => ({
  dimensions: { accuracy: mean, clarity: mean, specificity: mean, usefulness: mean, voice: mean, ...dims },
  gatePassRate: gate,
  meanScore: mean,
});

test("a candidate wins only when nothing regresses and it takes at least half the pairs", () => {
  expect(decideRules(v(0.9, 7), v(0.9, 7.2), 0.6)).toEqual({ apply: true, reasons: [] });
  expect(decideRules(v(0.9, 7), v(0.8, 7.2), 0.6).reasons[0]).toContain("gate pass rate");
  expect(decideRules(v(0.9, 7), v(0.9, 6.85), 0.6).reasons[0]).toContain("mean score");
  expect(decideRules(v(0.9, 7), v(0.9, 6.95), 0.6).apply).toBe(true);
  expect(decideRules(v(0.9, 7), v(0.9, 7.2, { voice: 6.6 }), 0.6).reasons[0]).toContain("voice");
  expect(decideRules(v(0.9, 7), v(0.9, 7.2), 0.4).reasons[0]).toContain("pairwise");
  expect(decideRules(v(0.9, 7), v(0.9, 7.2), 0.5).apply).toBe(true);
});

test("A/B order is reproducible per seed and varies across seeds", () => {
  expect(candidateFirst("01-x:normal")).toBe(candidateFirst("01-x:normal"));
  expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(candidateFirst)).size).toBe(2);
});

test("summarize averages the rubric and the gate pass rate, counting failed generations as failures", () => {
  const d = (rubric: number, passed: boolean, error?: string): EvalDraft => ({
    briefId: "x", mode: "normal", title: "t", description: "d", markdown: "m", failedGates: passed ? [] : ["structure"], passed, costUsd: 0.1, error,
    rubric: { accuracy: rubric, clarity: rubric, specificity: rubric, usefulness: rubric, voice: rubric },
  });
  const s = summarize([d(8, true), d(6, false), d(1, false, "boom")]);
  expect(s.meanScore).toBe(5);
  expect(s.gatePassRate).toBe(0.333);
});
