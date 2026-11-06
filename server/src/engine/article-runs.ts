import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { articleEvidence, articleGateResults, articleRuns, articleSources, articleStageRuns, campaignItems, jobs, siteIntegrations } from "../db/schema.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { persistentBackgroundExecution } from "../services/background-drain.js";
import { finishOperationEvent, safeOperationMetadata, startOperationEvent } from "../services/operation-events.js";
import { getEffectiveSettings, getSiteForUser } from "../services/user-settings.js";
import { engineAiEndpoint } from "./adapters/llm.js";
import { estimateRunUsd, parseEngineSettings, resolveRunSettings } from "./modes.js";
import { resolveDestinationProvider } from "./profile.js";
import { claimArticleRuns } from "./runtime/claim.js";
import { advanceArticleRun, failRunWithoutStage } from "./runtime/advance.js";
import { loadEngineDeps } from "./runtime/deps.js";
import type { ArticleRunRow } from "./runtime/stage.js";
import { claimIdsByEvidence, stageDetails } from "./run-view.js";
import { STAGES } from "./stages/index.js";
import { StageInputError, type EngineMode, type ModelRole, type StageKey } from "./types.js";
import { resolveEngineModel, userSubscriptions } from "../services/engine-llm.js";
import { disallowedSubscriptionRoles } from "./adapters/subscription.js";

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

export function engineAvailability(env: Env = process.env, hasOpenRouterKey = true) {
  const has = (key: string) => Boolean(env[key]?.trim());
  const reason = !persistentBackgroundExecution(env) ? "worker_required"
    : !engineAiEndpoint(env, hasOpenRouterKey ? "key" : null) ? "ai_key_missing"
    : null;
  return {
    available: reason === null,
    reason,
    adapters: {
      searxng: has("SEARXNG_URL"),
      crawl4ai: has("CRAWL4AI_URL"),
      dataforseo: has("DATAFORSEO_LOGIN") && has("DATAFORSEO_PASSWORD"),
      gateway: has("ENGINE_AI_BASE_URL") ? "custom" as const : "openrouter" as const,
    },
  };
}

export function engineSettingsResponse(raw: unknown, env: Env = process.env, hasOpenRouterKey = true) {
  return {
    settings: parseEngineSettings(raw),
    availability: engineAvailability(env, hasOpenRouterKey),
    estimates: { normal: estimateRunUsd("normal"), deep: estimateRunUsd("deep") },
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
  /** An SEO-plan item this run fulfils; validated by the caller. */
  campaign?: { campaignId: string; campaignItemId: string } | null;
  /** Editor's angle and instructions for the plan stage. */
  guidance?: { angle?: string | null; instructions?: string | null } | null;
  /** Queue one AI cover when the draft is delivered. */
  cover?: boolean;
}): Promise<{ jobId: string; runId: string; estimateUsd: number }> {
  if (!persistentBackgroundExecution()) throw new EngineUnavailableError("worker_required");
  if (!(await getSiteForUser(input.userId, input.siteId))) throw new Error("Site not found");
  if (input.preferredIntegrationId) {
    const [integration] = await db.select({ siteId: siteIntegrations.siteId, status: siteIntegrations.status }).from(siteIntegrations)
      .where(and(eq(siteIntegrations.id, input.preferredIntegrationId), eq(siteIntegrations.userId, input.userId))).limit(1);
    if (!integration) throw new StageInputError("Integration not found");
    if (integration.siteId !== input.siteId) throw new StageInputError("Publishing target does not belong to the selected site");
    if (integration.status !== "connected") throw new StageInputError("Publishing target is not connected");
  }
  const openRouterKey = await getOpenRouterKey(input.userId);
  const endpoint = engineAiEndpoint(process.env, openRouterKey);
  if (!endpoint) throw new EngineUnavailableError("ai_key_missing");

  const settings = await getEffectiveSettings(input.userId, input.siteId);
  const resolved = resolveRunSettings(input.mode, parseEngineSettings(settings.engineSettings));
  const models = { ...resolved.models };
  // Fail at the start, not after a stage's retries: subscriptions are for the accounts the instance lists.
  const notAllowed = disallowedSubscriptionRoles(models, await userSubscriptions(input.userId));
  if (notAllowed.length) throw new StageInputError(`Subscription models are not enabled for this account (${notAllowed.join(", ")}). Choose an OpenRouter model for these steps.`);
  for (const role of Object.keys(models) as ModelRole[]) {
    models[role] = await resolveEngineModel(endpoint, models[role]);
  }
  const guidance = {
    angle: input.guidance?.angle?.trim().slice(0, 500) || undefined,
    instructions: input.guidance?.instructions?.trim().slice(0, 1500) || undefined,
  };
  const destinationProvider = await resolveDestinationProvider(input.userId, input.siteId, input.preferredIntegrationId);
  const frozen = {
    destinationProvider,
    models, budgetUsd: resolved.budgetUsd, citationStyle: resolved.citationStyle,
    ...(guidance.angle || guidance.instructions ? { guidance } : {}),
    ...(input.cover ? { cover: true } : {}),
  };

  return db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({
      userId: input.userId,
      siteId: input.siteId,
      preferredIntegrationId: input.preferredIntegrationId || null,
      campaignId: input.campaign?.campaignId ?? null,
      campaignItemId: input.campaign?.campaignItemId ?? null,
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
    if (input.campaign) {
      await tx.update(campaignItems).set({ jobId: job.id, status: "running", planningStatus: "in_progress", startedAt: new Date() })
        .where(and(eq(campaignItems.id, input.campaign.campaignItemId), eq(campaignItems.userId, input.userId)));
    }
    return { jobId: job.id, runId: run.id, estimateUsd: estimateRunUsd(input.mode) };
  });
}

/**
 * Claims due runs and advances each one stage; every advance leaves one sanitized ledger event.
 * The lease owner is unique per drain: a pid alone repeats across containers (often 1), which would defeat the fence.
 */
export async function drainArticleRuns(limit: number, workerId = `worker-${process.pid}-${randomUUID()}`): Promise<number> {
  const runs = await claimArticleRuns(workerId, limit, new Date());
  await Promise.allSettled(runs.map(async (run) => {
    const started = Date.now();
    const eventId = await startOperationEvent({
      userId: run.userId, siteId: run.siteId, origin: "system", action: "engine.stage",
      objectType: "article_run", objectId: run.id,
      metadata: safeOperationMetadata("engine.stage", { run_id: run.id, stage: run.currentStage, mode: run.mode, status: "started" }),
    });
    let status: "succeeded" | "failed" = "failed";
    let outcome = "failed";
    let costUsd = 0;
    try {
      const deps = await loadEngineDeps(run, STAGES).catch(async (error) => {
        // Unloadable dependencies never recover by retrying, so end the run instead of re-leasing it forever.
        if (error instanceof StageInputError) await failRunWithoutStage(run, error.message);
        throw error;
      });
      const result = await advanceArticleRun(run, deps);
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
      metadata: safeOperationMetadata("engine.stage", { run_id: run.id, stage: run.currentStage, mode: run.mode, status: outcome, cost_usd: costUsd, duration_ms: Date.now() - started }),
    });
  }));
  return runs.length;
}

export type StageRunSummary = {
  stage: StageKey; attempt: number; status: string; model: string | null; costUsd: number;
  startedAt: string; finishedAt: string | null; error: string | null; details: Record<string, unknown> | null;
};

export type RunSourceView = { id: string; url: string; title: string | null; fetchedVia: string | null; httpStatus: number | null; textLength: number | null };
export type RunEvidenceView = { claimId: string | null; sourceId: string; claim: string; quote: string; verified: boolean; method: string | null; reason: string | null };
export type RunGateView = { attempt: number; gate: string; passed: boolean; severity: string | null; issues: unknown; metrics: unknown };

export async function getArticleRunForJob(userId: string, jobId: string): Promise<{
  run: ArticleRunRow; stages: StageRunSummary[]; sources: RunSourceView[]; evidence: RunEvidenceView[]; gates: RunGateView[];
} | null> {
  const [run] = await db.select().from(articleRuns)
    .where(and(eq(articleRuns.jobId, jobId), eq(articleRuns.userId, userId))).limit(1);
  if (!run) return null;
  const scope = (t: typeof articleSources | typeof articleEvidence | typeof articleGateResults) => and(eq(t.runId, run.id), eq(t.userId, userId));
  const evidenceSources = and(scope(articleSources), eq(articleSources.kind, "evidence"));
  const [rows, sources, evidence, gates] = await Promise.all([
    db.select().from(articleStageRuns)
      .where(and(eq(articleStageRuns.runId, run.id), eq(articleStageRuns.userId, userId)))
      .orderBy(asc(articleStageRuns.startedAt)),
    db.select({
      id: articleSources.id, url: articleSources.url, title: articleSources.title, fetchedVia: articleSources.fetchedVia,
      httpStatus: articleSources.httpStatus, textLength: articleSources.textLength,
    }).from(articleSources).where(evidenceSources).orderBy(asc(articleSources.fetchedAt)),
    db.select({
      id: articleEvidence.id, sourceId: articleEvidence.sourceId, claim: articleEvidence.claim, quote: articleEvidence.quote,
      verified: articleEvidence.verified, method: articleEvidence.method, reason: articleEvidence.reason,
    }).from(articleEvidence).where(scope(articleEvidence)),
    db.select({
      attempt: articleGateResults.attempt, gate: articleGateResults.gate, passed: articleGateResults.passed,
      severity: articleGateResults.severity, issues: articleGateResults.issues, metrics: articleGateResults.metrics,
    }).from(articleGateResults).where(scope(articleGateResults)).orderBy(asc(articleGateResults.attempt), asc(articleGateResults.gate)),
  ]);
  const research = rows.findLast((r) => r.stage === "research" && r.status === "succeeded");
  const claimIds = claimIdsByEvidence(research?.output);
  return {
    run,
    stages: rows.map((r) => ({
      stage: r.stage as StageKey, attempt: r.attempt, status: r.status, model: r.model, costUsd: r.costUsd,
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
      details: r.status === "succeeded" || r.status === "reused" ? stageDetails(r.stage as StageKey, r.output) : null,
    })),
    sources,
    evidence: evidence
      .map(({ id, ...e }) => ({ claimId: claimIds.get(id) ?? null, ...e }))
      .sort((a, b) => Number(a.claimId?.slice(1) ?? 1e9) - Number(b.claimId?.slice(1) ?? 1e9)),
    gates,
  };
}
