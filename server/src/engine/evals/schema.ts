import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ENGINE_CONFIG } from "../config.js";
import { verifyQuote } from "../evidence/verify.js";
import type { EvidenceItem, SourceItem } from "../gates/types.js";

export const EVALS_DIR = fileURLToPath(new URL("./briefs/", import.meta.url));

/** One golden brief: a topic plus the frozen research it starts from. No network is used while evaluating. */
export const EvalBriefSchema = z.object({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  topic: z.string().min(3),
  locale: z.string().min(2),
  sources: z.array(z.object({ url: z.string().url(), title: z.string(), markdown: z.string() })).min(1),
  evidence: z
    .array(z.object({ claim: z.string(), kind: z.string(), quote: z.string(), url: z.string() }))
    .min(3),
});
export type EvalBrief = z.infer<typeof EvalBriefSchema>;

export async function loadEvalBriefFiles(files: string[]): Promise<EvalBrief[]> {
  return Promise.all(files.sort().map(async (f) => EvalBriefSchema.parse(JSON.parse(await readFile(f, "utf8")))));
}

export async function loadEvalBriefs(dir = EVALS_DIR): Promise<EvalBrief[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return loadEvalBriefFiles(names.map((n) => join(dir, n)));
}

/**
 * The frozen evidence as the stages read it: claim ids `c1`, `c2`, … in file order, each quote re-verified
 * against its source with the production verifier (a quote that drifted shows up as unverified).
 */
export function frozenEvidence(b: EvalBrief, now: Date): { evidence: EvidenceItem[]; sources: SourceItem[] } {
  const sources: SourceItem[] = b.sources.map((s, i) => ({ id: `s${i + 1}`, url: s.url, finalUrl: s.url, title: s.title, markdown: s.markdown }));
  const evidence = b.evidence.map((e, i) => {
    const src = sources.find((s) => s.url === e.url);
    const verified = src
      ? verifyQuote({ claim: e.claim, quote: e.quote, page: { markdown: src.markdown, status: 200, fetchedAt: now }, now, config: ENGINE_CONFIG.evidence }).verified
      : false;
    return { id: `c${i + 1}`, claim: e.claim, quote: e.quote, sourceId: src?.id ?? "", verified };
  });
  return { evidence, sources };
}
