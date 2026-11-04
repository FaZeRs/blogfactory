import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleRuns, articleStageRuns, jobs } from "../../db/schema.js";
import { checkAccountGuardrails } from "../../services/account-guardrails.js";
import { parseEngineSettings, resolveRunSettings } from "../modes.js";
import { RateLimitError, StageInputError, type EngineMode, type StageKey, type Transition } from "../types.js";
import type { EngineLlm } from "../adapters/llm.js";
import type { EngineDeps } from "./deps.js";
import { stageInputHash } from "./hash.js";
import type { ArticleRunRow, StageContext } from "./stage.js";

export type AdvanceKind =
  | "advanced" | "reused" | "done" | "escalated" | "retry" | "failed" | "rate_limited" | "budget_paused" | "lease_lost";

const MAX_ATTEMPTS = 3;
const RETRY_MS = [10 * 60_000, 30 * 60_000];
const MIN_RATE_LIMIT_MS = 60_000;
const PAUSE_MS = 60 * 60_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RunPatch = Partial<typeof articleRuns.$inferInsert>;
type StageRowSet = Partial<typeof articleStageRuns.$inferInsert>;
/** One planned outcome; `commit` is the only place that writes it. */
type Plan = { kind: AdvanceKind; patch: RunPatch; row: StageRowSet | "delete"; mirror?: boolean };

const trunc = (text: string) => text.slice(0, 300);

function transitionPatch(next: Transition, stage: StageKey, run: ArticleRunRow, now: Date): { kind: AdvanceKind; patch: RunPatch } {
  const revised = stage === "revise" && (next.type === "advance" || next.type === "wait") ? { reviseCount: run.reviseCount + 1 } : {};
  switch (next.type) {
    case "advance": return { kind: "advanced", patch: { currentStage: next.to, nextAttemptAt: now, stateReason: null, ...revised } };
    case "wait": return { kind: "advanced", patch: { currentStage: next.to, nextAttemptAt: next.at, stateReason: null, ...revised } };
    case "done": return { kind: "done", patch: { state: "done", stateReason: null } };
    case "escalate": return { kind: "escalated", patch: { state: "escalated", stateReason: next.reason } };
  }
}

/** Stored transitions come back from jsonb, so a wait date is a string again. */
function parseTransition(value: unknown): Transition | null {
  const t = (value as { next?: Record<string, unknown> } | null)?.next;
  if (!t || typeof t !== "object") return null;
  if (t.type === "wait") return { type: "wait", to: t.to as StageKey, at: new Date(t.at as string) };
  if (t.type === "advance") return { type: "advance", to: t.to as StageKey };
  if (t.type === "done") return { type: "done" };
  if (t.type === "escalate") return { type: "escalate", reason: String(t.reason) };
  return null;
}

async function mirrorJob(tx: Tx, run: ArticleRunRow, now: Date) {
  if (!run.jobId) return;
  const base = { currentStep: `engine_${run.currentStage}`, totalCost: run.spentUsd };
  const terminal = run.state === "done" || run.state === "failed" || run.state === "escalated";
  const set = !terminal
    ? base
    : {
        ...base,
        status: run.state !== "failed" && run.postId ? "completed" : "failed",
        completedAt: now,
        errorMessage: run.state === "done" ? null : run.stateReason,
      };
  await tx.update(jobs).set(set).where(and(eq(jobs.id, run.jobId), eq(jobs.userId, run.userId)));
}

/**
 * One conditional UPDATE decides the winner (lease_owner + version + user_id). A loser writes nothing.
 * Stage side effects that wrote child rows before this point stay behind on lease loss; the run does not advance.
 */
async function commit(run: ArticleRunRow, stageRowId: string, stage: StageKey, plan: Plan, now: Date) {
  const won = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(articleRuns)
      .set({ ...plan.patch, version: sql`${articleRuns.version} + 1`, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(
        eq(articleRuns.id, run.id),
        eq(articleRuns.userId, run.userId),
        eq(articleRuns.leaseOwner, run.leaseOwner!),
        eq(articleRuns.version, run.version),
      ))
      .returning();
    if (!updated) return false;
    const rowWhere = and(eq(articleStageRuns.id, stageRowId), eq(articleStageRuns.userId, run.userId), eq(articleStageRuns.runId, run.id));
    if (plan.row === "delete") await tx.delete(articleStageRuns).where(rowWhere);
    else await tx.update(articleStageRuns).set({ finishedAt: now, ...plan.row }).where(rowWhere);
    if (plan.mirror !== false) await mirrorJob(tx, updated, now);
    return true;
  });
  if (won) return { kind: plan.kind, stage };
  await db.update(articleStageRuns)
    .set({ status: "failed", error: "lease lost", finishedAt: now })
    .where(and(
      eq(articleStageRuns.id, stageRowId),
      eq(articleStageRuns.userId, run.userId),
      eq(articleStageRuns.runId, run.id),
      eq(articleStageRuns.status, "running"),
    ));
  return { kind: "lease_lost" as const, stage };
}

/** Consecutive failures since the stage last succeeded; lease-lost attempts and rate limits do not count. */
function failureStreak(prior: { status: string; error: string | null }[]) {
  let n = 0;
  for (const r of prior) {
    if (r.status === "failed" && r.error === "lease lost") continue;
    if (r.status === "failed" || r.status === "running") n += 1;
    else break;
  }
  return n;
}

export async function advanceArticleRun(run: ArticleRunRow, deps: EngineDeps): Promise<{ kind: AdvanceKind; stage: StageKey }> {
  const stage = run.currentStage as StageKey;
  const now = deps.now();
  if (!run.leaseOwner) return { kind: "lease_lost", stage };

  // Run and job must share a tenant; a mismatch is corrupt data, so fail the run without touching the job.
  if (run.jobId) {
    const [job] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, run.jobId), eq(jobs.userId, run.userId))).limit(1);
    if (!job) {
      const { kind, stage: s } = await commitNoRow(run, stage, {
        kind: "failed", patch: { state: "failed", stateReason: "Run does not match its job" }, row: "delete", mirror: false,
      }, now);
      return { kind, stage: s };
    }
  }

  const prior = await db
    .select({ id: articleStageRuns.id, attempt: articleStageRuns.attempt, status: articleStageRuns.status, error: articleStageRuns.error })
    .from(articleStageRuns)
    .where(and(eq(articleStageRuns.runId, run.id), eq(articleStageRuns.userId, run.userId), eq(articleStageRuns.stage, stage)))
    .orderBy(desc(articleStageRuns.attempt));
  const streak = failureStreak(prior);
  const attempt = (prior[0]?.attempt ?? 0) + 1;

  // A leftover 'running' row means a worker died mid-stage; it counted above, so close it.
  await db.update(articleStageRuns)
    .set({ status: "failed", error: "lease expired", finishedAt: now })
    .where(and(
      eq(articleStageRuns.runId, run.id),
      eq(articleStageRuns.userId, run.userId),
      eq(articleStageRuns.stage, stage),
      eq(articleStageRuns.status, "running"),
    ));

  const [row] = await db
    .insert(articleStageRuns)
    .values({ runId: run.id, userId: run.userId, stage, attempt, status: "running", startedAt: now })
    .onConflictDoNothing()
    .returning({ id: articleStageRuns.id });
  if (!row) return { kind: "lease_lost", stage };

  const { preset, models } = resolveRunSettings(run.mode as EngineMode, parseEngineSettings(run.settings));
  const controller = new AbortController();
  const timer = run.leaseExpiresAt
    ? setTimeout(() => controller.abort(), Math.max(0, run.leaseExpiresAt.getTime() - now.getTime()))
    : undefined;

  const pause = (message: string): Plan => ({
    kind: "budget_paused",
    patch: { nextAttemptAt: new Date(now.getTime() + PAUSE_MS), stateReason: message },
    row: "delete",
  });
  // Every model call is tallied here so failed and rate-limited attempts still count against the budget.
  let attemptCost = 0;
  const llm: EngineLlm = {
    async json(req) {
      const r = await deps.llm.json(req);
      attemptCost += r.costUsd;
      return r;
    },
  };

  async function plan(): Promise<Plan> {
    const def = deps.stages[stage];
    if (!def) throw new StageInputError(`Stage ${stage} is not registered`);
    const ctx: StageContext = { run, deps: { ...deps, llm }, signal: controller.signal, attempt };
    const input = await def.input(ctx);
    const inputHash = stageInputHash(stage, def.promptVersion, models, input);

    const [hit] = await db
      .select({ output: articleStageRuns.output })
      .from(articleStageRuns)
      .where(and(
        eq(articleStageRuns.runId, run.id),
        eq(articleStageRuns.userId, run.userId),
        eq(articleStageRuns.stage, stage),
        eq(articleStageRuns.inputHash, inputHash),
        eq(articleStageRuns.status, "succeeded"),
      ))
      .orderBy(desc(articleStageRuns.attempt))
      .limit(1);
    const stored = hit ? parseTransition(hit.output) : null;
    if (hit && stored) {
      return {
        kind: "reused",
        patch: transitionPatch(stored, stage, run, now).patch,
        row: { status: "reused", inputHash, promptVersion: def.promptVersion, output: hit.output, costUsd: 0 },
      };
    }

    if (run.spentUsd + preset.estimateUsd[stage] > run.budgetUsd) {
      // The budget is frozen on the run, so waiting cannot help: fail instead of pausing forever.
      return {
        kind: "failed",
        patch: { state: "failed", stateReason: `Run budget reached: $${run.spentUsd.toFixed(2)} of $${run.budgetUsd.toFixed(2)} spent` },
        row: "delete",
      };
    }
    const guard = await checkAccountGuardrails(run.userId, now);
    if (guard.blocked) return pause(guard.message);

    const outcome = await def.run(input, ctx);
    const usage = outcome.usage ?? [];
    const cost = usage.reduce((sum, u) => sum + u.costUsd, 0);
    const { kind, patch } = transitionPatch(outcome.next, stage, run, now);
    return {
      kind,
      patch: { ...patch, spentUsd: run.spentUsd + cost },
      row: {
        status: "succeeded",
        inputHash,
        promptVersion: def.promptVersion,
        model: usage[0]?.model ?? null,
        promptTokens: usage.reduce((s, u) => s + u.promptTokens, 0),
        completionTokens: usage.reduce((s, u) => s + u.completionTokens, 0),
        costUsd: cost,
        output: { output: outcome.output, next: outcome.next },
      },
    };
  }

  let chosen: Plan;
  try {
    chosen = await plan();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitError) {
      chosen = {
        kind: "rate_limited",
        patch: { nextAttemptAt: new Date(now.getTime() + Math.max(err.retryAfterMs ?? 0, MIN_RATE_LIMIT_MS)), spentUsd: run.spentUsd + attemptCost },
        row: "delete",
      };
    } else {
      const failures = streak + 1;
      const final = err instanceof StageInputError || failures >= MAX_ATTEMPTS;
      chosen = {
        kind: final ? "failed" : "retry",
        patch: {
          spentUsd: run.spentUsd + attemptCost,
          ...(final ? { state: "failed", stateReason: trunc(message) } : { nextAttemptAt: new Date(now.getTime() + RETRY_MS[failures - 1]) }),
        },
        row: { status: "failed", error: trunc(message), costUsd: attemptCost },
      };
    }
  } finally {
    clearTimeout(timer);
  }
  // Finish time, not the claim time read before the stage ran.
  return commit(run, row.id, stage, chosen, deps.now());
}

/** Terminal write for a run that has no stage row yet. */
async function commitNoRow(run: ArticleRunRow, stage: StageKey, plan: Plan, now: Date) {
  const rows = await db
    .update(articleRuns)
    .set({ ...plan.patch, version: sql`${articleRuns.version} + 1`, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(
      eq(articleRuns.id, run.id),
      eq(articleRuns.userId, run.userId),
      eq(articleRuns.leaseOwner, run.leaseOwner!),
      eq(articleRuns.version, run.version),
    ))
    .returning({ id: articleRuns.id });
  return { kind: rows.length ? plan.kind : ("lease_lost" as const), stage };
}

/** Fails a leased run that never reached a stage (its dependencies could not load); same conditional write and job mirror as a commit. */
export async function failRunWithoutStage(run: ArticleRunRow, reason: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(articleRuns)
      .set({ state: "failed", stateReason: trunc(reason), version: sql`${articleRuns.version} + 1`, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(
        eq(articleRuns.id, run.id),
        eq(articleRuns.userId, run.userId),
        eq(articleRuns.leaseOwner, run.leaseOwner!),
        eq(articleRuns.version, run.version),
      ))
      .returning();
    if (!updated) return false;
    await mirrorJob(tx, updated, now);
    return true;
  });
}
