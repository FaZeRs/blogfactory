import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { articleRuns, articleStageRuns, jobs } from "../db/schema.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { persistentBackgroundExecution } from "../services/background-drain.js";
import { finishOperationEvent, startOperationEvent } from "../services/operation-events.js";
import { resolveOpenRouterTextModel } from "../services/openrouter-models.js";
import { getEffectiveSettings, getSiteForUser } from "../services/user-settings.js";
import { engineAiEndpoint } from "./adapters/llm.js";
import { estimateRunUsd, parseEngineSettings, resolveRunSettings } from "./modes.js";
import { claimArticleRuns } from "./runtime/claim.js";
import { advanceArticleRun } from "./runtime/advance.js";
import { loadEngineDeps } from "./runtime/deps.js";
import type { ArticleRunRow } from "./runtime/stage.js";
import { STAGES } from "./stages/index.js";
import type { EngineMode, ModelRole, StageKey } from "./types.js";

type Env = Record<string, string | undefined>;

export class EngineUnavailableError extends Error {
  code: "worker_required" | "ai_key_missing";
  constructor(code: "worker_required" | "ai_key_missing") {
    super(code === "worker_required"
      ? "Normal and deep modes need the persistent background worker (BACKGROUND_EXECUTION_MODE=worker)."
      : "Add an OpenRouter key in Settings, or configure ENGINE_AI_BASE_URL and ENGINE_AI_API_KEY, before using this mode.");
    this.name = "EngineUnavailableError";
    this.code = code;
  }
}

export function engineAvailability(env: Env = process.env) {
  const has = (key: string) => Boolean(env[key]?.trim());
  return {
    available: persistentBackgroundExecution(env),
    reason: persistentBackgroundExecution(env) ? null : "worker_required",
    adapters: {
      searxng: has("SEARXNG_URL"),
      crawl4ai: has("CRAWL4AI_URL"),
      dataforseo: has("DATAFORSEO_LOGIN") && has("DATAFORSEO_PASSWORD"),
      gateway: has("ENGINE_AI_BASE_URL") ? "custom" as const : "openrouter" as const,
    },
  };
}

export async function startArticleRun(input: {
  userId: string;
  siteId: string;
  mode: EngineMode;
  sourceType: "article_keyword" | "article_title";
  topic: string;
  preferredIntegrationId?: string | null;
  origin: "web" | "mcp";
}): Promise<{ jobId: string; runId: string; estimateUsd: number }> {
  if (!persistentBackgroundExecution()) throw new EngineUnavailableError("worker_required");
  if (!(await getSiteForUser(input.userId, input.siteId))) throw new Error("Site not found");
  const openRouterKey = await getOpenRouterKey(input.userId);
  const endpoint = engineAiEndpoint(process.env, openRouterKey);
  if (!endpoint) throw new EngineUnavailableError("ai_key_missing");

  const settings = await getEffectiveSettings(input.userId, input.siteId);
  const resolved = resolveRunSettings(input.mode, parseEngineSettings(settings.engineSettings));
  const models = { ...resolved.models };
  if (endpoint.gateway === "openrouter") {
    for (const role of Object.keys(models) as ModelRole[]) {
      models[role] = await resolveOpenRouterTextModel(endpoint.apiKey, models[role]);
    }
  }
  const frozen = { models, budgetUsd: resolved.budgetUsd, citationStyle: resolved.citationStyle };

  return db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({
      userId: input.userId,
      siteId: input.siteId,
      preferredIntegrationId: input.preferredIntegrationId || null,
      sourceType: input.sourceType,
      sourceValue: input.topic,
      modelId: models.draft,
      status: "running",
      currentStep: "engine_research",
      startedAt: new Date(),
      generationPlan: { totalDrafts: 1, origin: input.origin, engine: { mode: input.mode } },
    }).returning({ id: jobs.id });
    const [run] = await tx.insert(articleRuns).values({
      userId: input.userId,
      siteId: input.siteId,
      jobId: job.id,
      preferredIntegrationId: input.preferredIntegrationId || null,
      mode: input.mode,
      sourceType: input.sourceType,
      topic: input.topic,
      settings: frozen,
      budgetUsd: resolved.budgetUsd,
    }).returning({ id: articleRuns.id });
    return { jobId: job.id, runId: run.id, estimateUsd: estimateRunUsd(input.mode) };
  });
}

/** Claims due runs and advances each one stage; every advance leaves one sanitized ledger event. */
export async function drainArticleRuns(limit: number, workerId = `worker-${process.pid}`): Promise<number> {
  const runs = await claimArticleRuns(workerId, limit, new Date());
  await Promise.allSettled(runs.map(async (run) => {
    const started = Date.now();
    const eventId = await startOperationEvent({
      userId: run.userId, siteId: run.siteId, origin: "system", action: "engine.stage",
      objectType: "article_run", objectId: run.id,
      metadata: { run_id: run.id, stage: run.currentStage, mode: run.mode, status: "started" },
    });
    let status: "succeeded" | "failed" = "failed";
    let outcome = "failed";
    let costUsd = 0;
    try {
      const result = await advanceArticleRun(run, await loadEngineDeps(run, STAGES));
      outcome = result.kind;
      status = result.kind === "failed" || result.kind === "lease_lost" ? "failed" : "succeeded";
      const [after] = await db.select({ spent: articleRuns.spentUsd }).from(articleRuns)
        .where(and(eq(articleRuns.id, run.id), eq(articleRuns.userId, run.userId))).limit(1);
      costUsd = Math.max(0, (after?.spent ?? run.spentUsd) - run.spentUsd);
    } catch (error) {
      console.error("[engine] Stage crashed", { runId: run.id, stage: run.currentStage, error: error instanceof Error ? error.message : String(error) });
    }
    await finishOperationEvent({
      id: eventId, status, durationMs: Date.now() - started, siteId: run.siteId,
      metadata: { run_id: run.id, stage: run.currentStage, mode: run.mode, status: outcome, cost_usd: costUsd, duration_ms: Date.now() - started },
    });
  }));
  return runs.length;
}

export type StageRunSummary = {
  stage: StageKey; attempt: number; status: string; model: string | null; costUsd: number;
  startedAt: string; finishedAt: string | null; error: string | null;
};

export async function getArticleRunForJob(userId: string, jobId: string): Promise<{ run: ArticleRunRow; stages: StageRunSummary[] } | null> {
  const [run] = await db.select().from(articleRuns)
    .where(and(eq(articleRuns.jobId, jobId), eq(articleRuns.userId, userId))).limit(1);
  if (!run) return null;
  const rows = await db.select().from(articleStageRuns)
    .where(and(eq(articleStageRuns.runId, run.id), eq(articleStageRuns.userId, userId)))
    .orderBy(asc(articleStageRuns.startedAt));
  return {
    run,
    stages: rows.map((r) => ({
      stage: r.stage as StageKey, attempt: r.attempt, status: r.status, model: r.model, costUsd: r.costUsd,
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
    })),
  };
}
