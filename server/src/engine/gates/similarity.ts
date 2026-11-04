import type { EngineConfig } from "../config.js";
import { normalizeText } from "../evidence/normalize.js";
import { toPlainText } from "../markdown/plain-text.js";
import { type GateInput, type GateIssue, type GateResult, gateResult } from "./types.js";

const SHINGLE_WORDS = 5;
const PERCENT = 100;

function shingles(markdown: string): Set<string> {
  const words = normalizeText(toPlainText(markdown)).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const s of a) {
    if (b.has(s)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

/**
 * Compares the article with the site's existing posts by Jaccard similarity of 5-word shingles; a post
 * at or above `similarityMax` blocks.
 * shortcut: lexical, upgrade to pgvector in sub-project 4 (novelty).
 */
export function similarityGate(
  input: Pick<GateInput, "markdown" | "existingPosts">,
  cfg: EngineConfig["gates"]
): GateResult {
  const draft = shingles(input.markdown);
  const issues: GateIssue[] = [];
  let maxSimilarity = 0;
  for (const post of input.existingPosts) {
    const similarity = jaccard(draft, shingles(post.content));
    maxSimilarity = Math.max(maxSimilarity, similarity);
    if (similarity >= cfg.similarityMax) {
      issues.push({
        hint: "choose a different angle or turn this into an update of that post",
        message: `reads ${(similarity * PERCENT).toFixed(0)}% like the existing post "${post.title}"`,
      });
    }
  }
  return gateResult("similarity", issues, "blocker", { maxSimilarity });
}
