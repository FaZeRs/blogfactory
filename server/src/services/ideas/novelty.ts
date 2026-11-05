/** Word-overlap similarity: no embeddings, deterministic. */
const STOP = new Set("a an the and or of to in on for with how what why is are be your you i it its at by from as this that vs".split(" "));

export function tokens(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    // Crude plural fold so "tools" matches "tool".
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

const bigrams = (t: string[]) => new Set(t.slice(1).map((w, i) => `${t[i]} ${w}`));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n += 1; return n; };

/** 0..1: the mean of token Jaccard and shared-bigram containment (shared / smaller set). */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const shared = overlap(ta, tb);
  const jaccard = shared / (ta.size + tb.size - shared);
  const ba = bigrams([...tokens(a)]);
  const bb = bigrams([...tokens(b)]);
  if (!ba.size || !bb.size) return jaccard;
  const containment = overlap(ba, bb) / Math.min(ba.size, bb.size);
  return Math.round(((jaccard + containment) / 2) * 1000) / 1000;
}

export const REJECT_SIMILARITY = 0.85;
export const REFRESH_SIMILARITY = 0.6;
/** Between two ideas: reworded repeats score 0.55-0.8 ("AI Document Processing: From Reading to Verification" vs "Document Processing With AI: …Verification Task" is 0.575). */
export const IDEA_REPEAT_SIMILARITY = 0.55;

export type NoveltyDecision = {
  decision: "ok" | "refresh" | "reject";
  /** 0.05..1; 1 means nothing similar exists. */
  novelty: number;
  nearest: { id: string; title: string; similarity: number } | null;
};

/** Compares the idea's title and keyword with every existing title. At 0.85 or more it is a duplicate; at 0.6 a refresh candidate. */
export function assessNovelty(idea: { title: string; keyword?: string | null }, existing: { id: string; title: string }[]): NoveltyDecision {
  let nearest: NoveltyDecision["nearest"] = null;
  for (const e of existing) {
    const s = Math.max(similarity(idea.title, e.title), idea.keyword ? similarity(idea.keyword, e.title) : 0);
    if (!nearest || s > nearest.similarity) nearest = { id: e.id, title: e.title, similarity: s };
  }
  if (!nearest) return { decision: "ok", novelty: 1, nearest: null };
  const novelty = Math.round(Math.min(1, Math.max(0.05, 1 - nearest.similarity)) * 1000) / 1000;
  const decision = nearest.similarity >= REJECT_SIMILARITY ? "reject" : nearest.similarity >= REFRESH_SIMILARITY ? "refresh" : "ok";
  return { decision, novelty, nearest: nearest.similarity > 0 ? nearest : null };
}
