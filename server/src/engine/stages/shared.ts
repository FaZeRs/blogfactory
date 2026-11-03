import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleEvidence, articleSources, articleStageRuns } from "../../db/schema.js";
import type { EvidenceItem, SourceItem } from "../gates/types.js";
import { resolveRunSettings, parseEngineSettings } from "../modes.js";
import type { ArticleRunRow } from "../runtime/stage.js";
import { StageInputError, type EngineMode, type ModelRole, type StageKey } from "../types.js";
import type { ResearchOutput } from "./research/schema.js";

export const runSettings = (run: ArticleRunRow) => resolveRunSettings(run.mode as EngineMode, parseEngineSettings(run.settings));
export const modelFor = (run: ArticleRunRow, role: ModelRole) => runSettings(run).models[role];

/** The stored `.output.output` of the latest succeeded or reused row of a stage; user- and run-scoped. */
export async function latestStageOutput<T>(run: ArticleRunRow, stage: StageKey): Promise<T> {
  const [row] = await db
    .select({ output: articleStageRuns.output })
    .from(articleStageRuns)
    .where(and(
      eq(articleStageRuns.runId, run.id),
      eq(articleStageRuns.userId, run.userId),
      eq(articleStageRuns.stage, stage),
      inArray(articleStageRuns.status, ["succeeded", "reused"]),
    ))
    .orderBy(desc(articleStageRuns.attempt))
    .limit(1);
  const stored = row?.output as { output?: T } | null | undefined;
  if (!stored?.output) throw new StageInputError(`No ${stage} output for this run`);
  return stored.output;
}

/** Sources without page text (ids and URLs only), for prompts and citation rendering. */
export async function loadSources(run: ArticleRunRow, withMarkdown = false): Promise<SourceItem[]> {
  const rows = await db
    .select()
    .from(articleSources)
    .where(and(eq(articleSources.runId, run.id), eq(articleSources.userId, run.userId)));
  return rows.map((s) => ({
    id: s.id,
    url: s.url,
    finalUrl: s.finalUrl ?? s.url,
    title: s.title,
    markdown: withMarkdown ? (s.markdown ?? "") : "",
  }));
}

/** Evidence as the gates and citations read it: `id` is the claim id (`c1`) the draft cites. */
export async function loadEvidence(run: ArticleRunRow): Promise<EvidenceItem[]> {
  const research = await latestStageOutput<ResearchOutput>(run, "research");
  const rows = await db
    .select()
    .from(articleEvidence)
    .where(and(eq(articleEvidence.runId, run.id), eq(articleEvidence.userId, run.userId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return research.claims.flatMap((c) => {
    const r = byId.get(c.evidenceId);
    return r ? [{ id: c.claimId, claim: r.claim, quote: r.quote, sourceId: r.sourceId, verified: r.verified }] : [];
  });
}

export type PromptEvidence = { id: string; claim: string; quote: string; url: string };
export const evidenceText = (rows: PromptEvidence[]) =>
  rows.map((e) => `[${e.id}] ${e.claim}\n    quote: "${e.quote}"\n    source: ${e.url}`).join("\n");

/** Internal link candidates come from the site's link index only. */
export type LinkCandidate = { url: string; title: string };
export const linksText = (links: LinkCandidate[]) => (links.length ? links.map((l) => `- ${l.url} — ${l.title}`).join("\n") : "None.");

/** Models sometimes wrap the article in a code fence or repeat the title as an H1. */
export function normalizeDraftMarkdown(md: string): string {
  let text = md.replace(/\r\n/g, "\n").trim();
  const wrapped = /^(`{3,}|~{3,})(?:markdown|md|mdx)?[ \t]*\n([\s\S]*)\n\1[ \t]*$/i.exec(text);
  if (wrapped) text = wrapped[2]!;
  return `${text.replace(/^\s*# [^\n]*\n+/, "").trim()}\n`;
}
