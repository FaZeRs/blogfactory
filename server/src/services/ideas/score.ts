import { SCORE_FACTORS, type ScoreWeights } from "./settings.js";

export type Factors = Record<typeof SCORE_FACTORS[number], number>;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Weighted geometric mean, 0..100. One factor at 0 gives 0; weight 0 ignores a factor. */
export function combineScore(f: Factors, w: ScoreWeights): number {
  let total = 0;
  let logSum = 0;
  for (const k of SCORE_FACTORS) {
    const weight = Math.max(0, w[k]);
    if (weight === 0) continue;
    const v = clamp01(f[k]);
    if (v === 0) return 0;
    logSum += weight * Math.log(v);
    total += weight;
  }
  return total ? Math.round(1000 * Math.exp(logSum / total)) / 10 : 0;
}

export type TrendMeta = { signalCount: number; distinctSources: number; avgAgeDays: number };
export const TREND_FLOOR = 0.15;

/** Cluster size 40%, source variety 30%, freshness 30%, lifted to the floor so trend is never 0. */
export function trendFactor(m: TrendMeta): number {
  const size = Math.min(1, m.signalCount / 8);
  const diversity = Math.min(1, m.distinctSources / 4);
  const recency = Math.max(0, 1 - m.avgAgeDays / 14);
  return round3(TREND_FLOOR + (1 - TREND_FLOOR) * (0.4 * size + 0.3 * diversity + 0.3 * recency));
}

/** 1 - KD/100, floored at 0.15; 0.6 when there is no keyword data. */
export function feasibilityFactor(difficulty: number | null | undefined): number {
  return difficulty == null ? 0.6 : round3(Math.max(0.15, 1 - clamp01(difficulty / 100)));
}

/** 0.6 * data + 0.4 * model estimate (0..10). No volume data: the estimate alone. Volume 0 caps at 0.2 unless trend is 0.6+. */
export function demandFactor(i: { volume: number | null; estimate: number; trend: number }): number {
  const est = clamp01(i.estimate / 10);
  if (i.volume == null) return round3(est);
  const data = clamp01(Math.log10(1 + Math.max(0, i.volume)) / 4);
  const blended = 0.6 * data + 0.4 * est;
  return round3(i.volume <= 0 && i.trend < 0.6 ? Math.min(blended, 0.2) : blended);
}
