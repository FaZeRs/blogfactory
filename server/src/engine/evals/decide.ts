export const RUBRIC_DIMENSIONS = ["usefulness", "specificity", "clarity", "voice", "accuracy"] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export type VariantSummary = {
  dimensions: Record<RubricDimension, number>;
  gatePassRate: number;
  meanScore: number;
};

/** A candidate mode beats the baseline only when none of these slip. */
export const EVAL_THRESHOLDS = { maxMeanDrop: 0.1, maxDimensionDrop: 0.3, minPairwiseWinRate: 0.5 };

const EPS = 1e-9;
const f2 = (x: number) => x.toFixed(2);

/** Gates at least the baseline's, mean within 0.1, no dimension down by more than 0.3, pairwise win rate at least 50%. */
export function decideRules(
  baseline: VariantSummary,
  candidate: VariantSummary,
  pairwiseWinRate: number,
  cfg = EVAL_THRESHOLDS,
): { apply: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.gatePassRate + EPS < baseline.gatePassRate) {
    reasons.push(`gate pass rate fell from ${f2(baseline.gatePassRate)} to ${f2(candidate.gatePassRate)}`);
  }
  if (candidate.meanScore + EPS < baseline.meanScore - cfg.maxMeanDrop) {
    reasons.push(`mean score fell from ${f2(baseline.meanScore)} to ${f2(candidate.meanScore)}`);
  }
  for (const d of RUBRIC_DIMENSIONS) {
    const drop = baseline.dimensions[d] - candidate.dimensions[d];
    if (drop > cfg.maxDimensionDrop + EPS) reasons.push(`${d} fell by ${f2(drop)}`);
  }
  if (pairwiseWinRate + EPS < cfg.minPairwiseWinRate) {
    reasons.push(`pairwise win rate ${f2(pairwiseWinRate)} is below ${f2(cfg.minPairwiseWinRate)}`);
  }
  return { apply: reasons.length === 0, reasons };
}
