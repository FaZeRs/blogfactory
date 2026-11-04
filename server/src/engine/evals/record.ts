import type { ResearchResult } from "../stages/research/index.js";
import { EvalBriefSchema, type EvalBrief } from "./schema.js";

const FOLD: Record<string, string> = { ı: "i", İ: "i", ß: "ss", ł: "l", Ł: "l", ø: "o", Ø: "o", đ: "d", Đ: "d" };

/** `Diş hekimi fiyatları` -> `dis-hekimi-fiyatlari`: ASCII only, so the id is a safe file name. */
export function slugify(text: string, max = 40): string {
  const folded = text
    .replace(/[ıİßłŁøØđĐ]/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "brief";
}

/** `11-<slug>`: one past the highest number among the existing brief file names. */
export function nextBriefId(existing: string[], topic: string): string {
  const highest = existing.reduce((n, f) => Math.max(n, Number(/^(\d{2})-/.exec(f)?.[1] ?? 0)), 0);
  return `${String(highest + 1).padStart(2, "0")}-${slugify(topic)}`;
}

/**
 * Freezes one research run into a brief: only verified claims, and only the sources they quote.
 * Review the result by hand before committing it; the model chose these claims.
 */
export function briefFromResearch(id: string, topic: string, locale: string, result: ResearchResult): EvalBrief {
  const verified = result.rows.filter((r) => r.verified);
  const used = [...new Set(verified.map((r) => r.sourceIndex))].sort((a, b) => a - b);
  return EvalBriefSchema.parse({
    id,
    topic,
    locale,
    sources: used.map((i) => ({ url: result.sources[i]!.finalUrl, title: result.sources[i]!.title ?? result.sources[i]!.finalUrl, markdown: result.sources[i]!.markdown })),
    evidence: verified.map((r) => ({ claim: r.claim, kind: r.kind, quote: r.quote, url: result.sources[r.sourceIndex]!.finalUrl })),
  });
}
