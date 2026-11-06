import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../../db/index.js";
import { articleGateResults } from "../../../db/schema.js";
import { DATA_RULE, fenceData, preparePrompt, promptVersion } from "../../prompts/load.js";
import type { Stage, StageContext, StageOutcome } from "../../runtime/stage.js";
import { truncate } from "../../util.js";
import type { BriefOutput } from "../brief/schema.js";
import { loadWriterContext, type DraftInput } from "../draft/index.js";
import type { DraftOutput } from "../draft/schema.js";
import { evidenceText, findStageOutput, latestDraft, modelFor, runSettings } from "../shared.js";
import { FactcheckSchema, REVIEW_GATES, ReaderSchema, type ReviewOutput } from "./schema.js";

export type ReviewInput = DraftInput & { draft: DraftOutput; previousBlockers: number | null; reviseCount: number };

type Kind = string;
type Found = { gate: (typeof REVIEW_GATES)[number]; kind: Kind; excerpt: string; fix: string; blocker: boolean };

const EXCERPT_MAX = 200;
const REASON_MAX = 280;
const MAX_ISSUES = { factcheck: 12, reader: 6 };
const MESSAGES: Record<Kind, string> = {
  unsupported: "Claim is not supported by the evidence",
  contradiction: "Statement contradicts the evidence",
  uncited_fact: "Factual statement has no citation",
  overstated: "Claim is stronger than the evidence allows",
  unclear: "Unclear passage",
  missing_step: "A step the reader needs is missing",
  unanswered_question: "A planned question is not answered",
  padding: "Padding adds nothing for the reader",
  jargon: "Technical term is not explained",
};
const FACTCHECK_BLOCKERS = new Set(["unsupported", "contradiction", "uncited_fact"]);

/** Whitespace, quote and dash variants, case and citation markers must not hide a real quote. */
export const normalizeForMatch = (text: string) =>
  text
    .replace(/\{\{c:[^}]*\}\}/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const words = (text: string) => new Set(normalizeForMatch(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));

/** A loose match: the issue shares at least 2 long words (or all of them, for a short plan item) with a planned item. */
export function matchesPlan(issueText: string, planned: string[]): boolean {
  const issue = words(issueText);
  return planned.some((p) => {
    const w = words(p);
    const need = Math.min(2, w.size);
    return need > 0 && [...w].filter((x) => issue.has(x)).length >= need;
  });
}

const plannedItems = (brief: BriefOutput) => [...brief.outline.map((s) => `${s.heading} ${s.purpose}`), ...brief.faq.map((f) => f.question)];

/** Drops excerpts that are not in the draft, then maps each issue to a blocker or a warning. Pure. */
export function classify(
  gate: "factcheck" | "reader",
  issues: { kind: Kind; excerpt: string; fix: string }[],
  raw: string,
  brief: BriefOutput,
): { found: Found[]; dropped: number } {
  const haystack = normalizeForMatch(raw);
  const planned = plannedItems(brief);
  const found: Found[] = [];
  let dropped = 0;
  for (const issue of issues.slice(0, MAX_ISSUES[gate])) {
    const needle = normalizeForMatch(issue.excerpt);
    if (!needle || !haystack.includes(needle)) {
      dropped += 1;
      continue;
    }
    const blocker = gate === "factcheck"
      ? FACTCHECK_BLOCKERS.has(issue.kind)
      : (issue.kind === "missing_step" || issue.kind === "unanswered_question") && matchesPlan(`${issue.excerpt} ${issue.fix}`, planned);
    found.push({ gate, kind: issue.kind, excerpt: truncate(issue.excerpt.trim(), EXCERPT_MAX), fix: issue.fix.trim(), blocker });
  }
  return { found, dropped };
}

type GateRow = { gate: "factcheck" | "reader"; found: Found[]; dropped: number };

/** The model calls and the decision, with no database: the stage stores `rows`, the eval harness ignores them. */
export async function reviewDraft(input: ReviewInput, ctx: StageContext): Promise<{ outcome: StageOutcome<ReviewOutput>; rows: GateRow[] }> {
  const { run } = ctx;
  const checks = runSettings(run).preset.review;
  const raw = input.draft.markdown;
  const evidence = fenceData("evidence", evidenceText(input.evidence));
  const article = fenceData("article", raw);
  const call = async (name: "factcheck" | "reader", schema: z.ZodType<{ issues: { kind: string; excerpt: string; fix: string }[] }>, vars: Record<string, string>) => {
    const prompt = await preparePrompt(`review-${name}`, { dataRule: DATA_RULE, draft: article, ...vars });
    return ctx.deps.llm.json({ role: "review", model: modelFor(run, "review"), system: prompt.system, user: prompt.user, schema, maxTokens: 12_000, signal: ctx.signal });
  };
  const b = input.brief;
  const plan = [
    `Angle: ${b.angle}`,
    `Primary keyword: ${b.primaryKeyword}`,
    `Outline (heading: purpose):\n${b.outline.map((s) => `- ${s.heading}: ${s.purpose}`).join("\n")}`,
    `FAQ questions:\n${b.faq.map((f) => `- ${f.question}`).join("\n") || "None."}`,
  ].join("\n");
  // One after the other: a fixed call order keeps replies, usage and retries deterministic; only deep runs two.
  const replies = [];
  for (const name of checks) {
    replies.push(name === "factcheck"
      ? { name, r: await call(name, FactcheckSchema, { evidence }) }
      : { name, r: await call(name, ReaderSchema, { keyword: input.brief.primaryKeyword, plan: fenceData("plan", plan) }) });
  }

  const rows = replies.map(({ name, r }) => ({ gate: name, ...classify(name, r.value.issues, raw, input.brief) }));
  const found = rows.flatMap((g) => g.found);
  const dropped = rows.reduce((n, g) => n + g.dropped, 0);
  const blockers = found.filter((f) => f.blocker).map((f) => ({ gate: f.gate, message: MESSAGES[f.kind] ?? f.kind, excerpt: f.excerpt, fix: f.fix }));

  const usage = replies.map(({ r }) => ({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd }));
  const base = { blockerCount: blockers.length, warningCount: found.length - blockers.length, blockers, dropped };
  const outcome = (to: "deliver" | "revise", out: Omit<ReviewOutput, keyof typeof base>) => ({ outcome: { next: { type: "advance", to }, output: { ...base, ...out }, usage } as StageOutcome<ReviewOutput>, rows });
  if (blockers.length === 0) return outcome("deliver", { passed: true, escalated: false, reason: null });
  // Same stop rules as the gates stage: revise loops are spent, or the last revision did not shrink the list.
  const stalled = input.previousBlockers !== null && blockers.length >= input.previousBlockers;
  if (input.reviseCount < runSettings(run).preset.maxRevise && !stalled) return outcome("revise", { passed: false, escalated: false, reason: null });
  const reason = truncate(`Review still failing: ${blockers.slice(0, 3).map((x) => `${x.gate}: ${x.message}`).join("; ")}`, REASON_MAX);
  return outcome("deliver", { passed: false, escalated: true, reason });
}

export const reviewStage: Stage<ReviewInput, ReviewOutput> = {
  key: "review",
  promptVersion: await promptVersion("review-factcheck", "review-reader"),
  async input({ run }) {
    const [context, draft, previous] = await Promise.all([loadWriterContext(run), latestDraft(run), findStageOutput<ReviewOutput>(run, "review")]);
    return { ...context, draft, previousBlockers: previous?.output.blockerCount ?? null, reviseCount: run.reviseCount };
  },
  async run(input, ctx) {
    const { run } = ctx;
    const { outcome, rows } = await reviewDraft(input, ctx);
    // A retried attempt replaces its own rows; the gates stage shares the attempt number, so only these gates are touched.
    await db.transaction(async (tx) => {
      const where = and(
        eq(articleGateResults.runId, run.id), eq(articleGateResults.userId, run.userId), eq(articleGateResults.attempt, ctx.attempt),
        inArray(articleGateResults.gate, [...REVIEW_GATES]),
      );
      await tx.delete(articleGateResults).where(where);
      if (!rows.length) return;
      await tx.insert(articleGateResults).values(rows.map((g) => ({
        runId: run.id, userId: run.userId, attempt: ctx.attempt, gate: g.gate, passed: g.found.length === 0,
        // A clean row stays "blocker" severity so the run view shows it as passed.
      severity: g.found.length === 0 || g.found.some((f) => f.blocker) ? "blocker" : "warning",
        issues: g.found.map((f) => ({ message: `${MESSAGES[f.kind] ?? f.kind}: \u201C${f.excerpt}\u201D`, excerpt: f.excerpt, hint: f.fix })),
        metrics: { issues: g.found.length, dropped: g.dropped },
      })));
    });
    return outcome;
  },
};
