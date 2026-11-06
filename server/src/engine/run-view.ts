import type { StageKey } from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pick = (o: Obj, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/**
 * What a stage did, in a shape the run view can show. Article text stays out:
 * the draft lives on the post, so draft and revise only report title and length.
 */
export function stageDetails(stage: StageKey, stored: unknown): Obj | null {
  const out = obj(obj(stored).output);
  if (!Object.keys(out).length) return null;
  switch (stage) {
    case "research":
      return {
        ...pick(out, ["queries", "searchAdapter", "sourceCount", "skippedSources", "claimCount", "verifiedCount", "questions"]),
        competitors: arr(out.competitors).map((c) => pick(obj(c), ["url", "title", "words", "outline"])),
        serpAnalysis: out.serpAnalysis ? pick(obj(out.serpAnalysis), ["searchIntent", "coveredTopics", "gaps", "informationGain", "typicalLength"]) : null,
      };
    case "brief":
      return {
        ...pick(out, ["chosenTitle", "titleOptions", "angle", "description", "primaryKeyword", "keywordData", "takeaways"]),
        outline: arr(out.outline).map((s) => pick(obj(s), ["heading", "purpose", "words", "claimIds"])),
        faq: arr(out.faq).map((f) => obj(f).question).filter(Boolean),
        internalLinks: arr(out.internalLinks).map((l) => pick(obj(l), ["url", "anchorText"])),
      };
    case "draft":
    case "revise":
      return pick(out, ["title", "words"]);
    case "gates":
    case "review":
      return pick(out, ["passed", "escalated", "reason", "blockers", "blockerCount", "warningCount", "dropped"]);
    case "localize":
      return { locales: arr(out.locales).map((l) => ({ ...pick(obj(l), ["locale", "status", "error", "costUsd"]), blockers: arr(obj(l).findings).filter((f) => obj(f).severity === "blocker").length, warnings: arr(obj(l).findings).filter((f) => obj(f).severity === "warning").length })) };
    case "deliver":
      return pick(out, ["postId", "created", "escalated"]);
    default:
      return null;
  }
}

/** Research stores claim ids (c1, c2…) against evidence rows; the brief and draft cite those ids. */
export function claimIdsByEvidence(researchOutput: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of arr(obj(obj(researchOutput).output).claims)) {
    const { claimId, evidenceId } = obj(c);
    if (typeof claimId === "string" && typeof evidenceId === "string") map.set(evidenceId, claimId);
  }
  return map;
}
