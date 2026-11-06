import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiAnswerChecks, generationLogs, sites, userSettings } from "../../db/schema.js";
import { checkAccountGuardrails } from "../account-guardrails.js";
import { getOpenRouterKey } from "../api-keys.js";
import { bareDomain, getIdeaSettings } from "../ideas/settings.js";
import { finishOperationEvent, startOperationEvent } from "../operation-events.js";
import { getSiteForUser } from "../user-settings.js";
import { classify } from "./detect.js";
import { askEngine, EngineError, QuotaError, RateLimitError, type AskArgs, type EngineAnswer } from "./engines.js";
import { questionHash } from "./questions.js";
import { engineLabel, normalizeVisibilitySettings } from "./settings.js";
import { isoWeek, monthCost } from "./summary.js";

export { isoWeek };

export const PAUSE_MS = 2_000;
export const MAX_RATE_WAIT_MS = 90_000;
export const STALE_RUN_MS = 30 * 60_000;
/** Scheduled retries of a failed pair wait this long, so a broken engine or empty key is not asked every hour. */
export const FAILED_BACKOFF_MS = 6 * 60 * 60_000;
const ANSWER_CAP = 4_000;
const ESTIMATE_USD: Record<string, number> = { openai: 0.04, perplexity: 0.015, google: 0.08 } // measured 2026-11; Gemini runs 2–6 paid searches per answer;


export const estimateUsd = (engine: string) => ESTIMATE_USD[engine.split("/")[0] ?? ""] ?? 0.05;

export type RunOpts = {
  now?: Date;
  ask?: (args: AskArgs) => Promise<EngineAnswer>;
  sleep?: (ms: number) => Promise<void>;
  /** Scheduled runs only: a pair that failed less than this long ago waits for a later pass. */
  failedBackoffMs?: number;
  /** Tests only; the stored OpenRouter key is used when absent. */
  apiKey?: string;
};

export type RunResult =
  | { status: "unavailable" }
  | { status: "blocked"; message: string }
  | { status: "running" }
  | { status: "capped"; week: string; spentUsd: number; estimateUsd: number; capUsd: number }
  | { status: "done"; week: string; asked: number; cited: number; failed: number; costUsd: number };

/** True while a run holds the site; a start older than 30 minutes counts as dead. */
export async function visibilityRunning(userId: string, siteId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ at: sites.aiVisibilityRunStartedAt }).from(sites).where(and(eq(sites.id, siteId), eq(sites.userId, userId)));
  return !!row?.at && now.getTime() - row.at.getTime() < STALE_RUN_MS;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Pair = { question: string; hash: string; engine: string };

/** Pairs without an `ok` answer this week. A failure newer than `failedSince` counts as settled, so retries back off. */
async function pendingPairs(userId: string, siteId: string, week: string, questions: string[], engines: string[], failedSince?: Date): Promise<Pair[]> {
  const settled = await db.select({ engine: aiAnswerChecks.engine, hash: aiAnswerChecks.questionHash }).from(aiAnswerChecks)
    .where(and(eq(aiAnswerChecks.userId, userId), eq(aiAnswerChecks.siteId, siteId), eq(aiAnswerChecks.week, week),
      failedSince ? or(eq(aiAnswerChecks.status, "ok"), gte(aiAnswerChecks.askedAt, failedSince)) : eq(aiAnswerChecks.status, "ok")));
  const ok = new Set(settled.map((d) => `${d.engine}\n${d.hash}`));
  return questions.flatMap((question) => {
    const hash = questionHash(question);
    return engines.filter((engine) => !ok.has(`${engine}\n${hash}`)).map((engine) => ({ question, hash, engine }));
  });
}

export async function runVisibility(userId: string, siteId: string, opts: RunOpts = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const site = await getSiteForUser(userId, siteId);
  if (!site) throw new Error("Site not found");
  const apiKey = opts.apiKey ?? await getOpenRouterKey(userId);
  if (!apiKey) return { status: "unavailable" };
  const guard = await checkAccountGuardrails(userId, now);
  if (guard.blocked) return { status: "blocked", message: guard.message };

  const [stored] = await db.select({ v: userSettings.aiVisibility }).from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.siteId, siteId))).limit(1);
  const settings = normalizeVisibilitySettings(stored?.v, site);
  const week = isoWeek(now);
  const failedSince = opts.failedBackoffMs ? new Date(now.getTime() - opts.failedBackoffMs) : undefined;
  const pending = await pendingPairs(userId, siteId, week, settings.questions, settings.engines, failedSince);
  if (!pending.length) return { status: "done", week, asked: 0, cited: 0, failed: 0, costUsd: 0 };

  const spentUsd = await monthCost(userId, siteId, now);
  const estimate = pending.reduce((sum, p) => sum + estimateUsd(p.engine), 0);
  if (spentUsd + estimate > settings.monthlyCapUsd) return { status: "capped", week, spentUsd, estimateUsd: estimate, capUsd: settings.monthlyCapUsd };

  // The claim is one atomic update, so it also keeps a second process out.
  const claimed = await db.update(sites).set({ aiVisibilityRunStartedAt: now })
    .where(and(eq(sites.id, siteId), eq(sites.userId, userId),
      or(isNull(sites.aiVisibilityRunStartedAt), lt(sites.aiVisibilityRunStartedAt, new Date(now.getTime() - STALE_RUN_MS)))))
    .returning({ id: sites.id });
  if (!claimed.length) return { status: "running" };

  const ask = opts.ask ?? askEngine;
  const sleep = opts.sleep ?? wait;
  const domain = bareDomain(site.domain) ?? site.domain.toLowerCase();
  const competitors = (await getIdeaSettings(userId, siteId)).competitors;
  const started = Date.now();
  const eventId = await startOperationEvent({ userId, siteId, origin: "system", action: "ai_visibility.run", objectType: "site", objectId: siteId });
  const totals = { asked: 0, cited: 0, failed: 0, costUsd: 0 };
  const stopped = new Set<string>();
  let first = true;
  try {
    for (const pair of pending) {
      if (stopped.has(pair.engine)) continue;
      // The estimate can undershoot; once real spend reaches the cap the rest stays pending.
      if (spentUsd + totals.costUsd >= settings.monthlyCapUsd) break;
      if (!first) {
        // Each call is logged spend, so a run that starts under the limits can cross them; the rest stays pending.
        if ((await checkAccountGuardrails(userId, new Date())).blocked) break;
        await sleep(PAUSE_MS);
      }
      first = false;
      const label = engineLabel(pair.engine);
      let row: Partial<typeof aiAnswerChecks.$inferInsert>;
      let cost = 0;
      let ok = false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await ask({ apiKey, model: pair.engine, question: pair.question });
          cost += res.costUsd;
          const c = classify({ answer: res.answer, citations: res.citations, domain, brandTerms: settings.brandTerms, competitors });
          row = { status: "ok", error: null, answer: res.answer.slice(0, ANSWER_CAP), ...c };
          ok = true;
          if (c.cited) totals.cited += 1;
        } catch (error) {
          // A rate-limited try that cost money is booked with the pair's row and spend log.
          cost += Number((error as { costUsd?: number })?.costUsd) || 0;
          if (error instanceof RateLimitError && attempt < 2) {
            await sleep(Math.min(error.retryAfterMs ?? 30_000, MAX_RATE_WAIT_MS));
            continue;
          }
          if (error instanceof QuotaError) stopped.add(pair.engine);
          const message = error instanceof EngineError ? error.message : "Request failed";
          row = { status: "failed", error: message.slice(0, 200), answer: null };
        }
        break;
      }
      totals.asked += 1;
      if (!ok) totals.failed += 1;
      totals.costUsd += cost;
      await db.insert(aiAnswerChecks).values({
        userId, siteId, week, question: pair.question, questionHash: pair.hash, engine: pair.engine, engineLabel: label, costUsd: cost, askedAt: new Date(), ...row,
      } as typeof aiAnswerChecks.$inferInsert).onConflictDoUpdate({
        target: [aiAnswerChecks.siteId, aiAnswerChecks.week, aiAnswerChecks.engine, aiAnswerChecks.questionHash],
        set: {
          status: sql`excluded.status`, error: sql`excluded.error`, answer: sql`excluded.answer`, cited: sql`excluded.cited`,
          citedUrls: sql`excluded.cited_urls`, mentioned: sql`excluded.mentioned`, otherHosts: sql`excluded.other_hosts`,
          competitorHosts: sql`excluded.competitor_hosts`, askedAt: sql`excluded.asked_at`,
          costUsd: sql`${aiAnswerChecks.costUsd} + excluded.cost_usd`, // a retry adds to what the failed try cost
        },
        setWhere: sql`${aiAnswerChecks.status} = 'failed'`,
      });
      if (cost > 0) {
        await db.insert(generationLogs).values({
          userId, usageType: "text", modelId: pair.engine, provider: pair.engine.split("/")[0] ?? null, status: ok ? "success" : "failed", cost,
          responseData: { aiVisibility: { siteId, week } },
        }).catch(() => console.error("[ai-visibility] Could not log spend"));
      }
      await db.update(sites).set({ aiVisibilityRunStartedAt: new Date() }).where(and(eq(sites.id, siteId), eq(sites.userId, userId))); // keeps a long run from looking stale
    }
    totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6; // float sums of many small costs
    await finishOperationEvent({ id: eventId, status: "succeeded", durationMs: Date.now() - started, metadata: { asked: totals.asked, cited: totals.cited, failed: totals.failed, cost_usd: totals.costUsd } });
    return { status: "done", week, ...totals };
  } catch (error) {
    await finishOperationEvent({ id: eventId, status: "failed", durationMs: Date.now() - started, errorCode: "run_failed", metadata: { asked: totals.asked, cited: totals.cited, failed: totals.failed, cost_usd: totals.costUsd } }).catch(() => {});
    throw error;
  } finally {
    await db.update(sites).set({ aiVisibilityRunStartedAt: null }).where(and(eq(sites.id, siteId), eq(sites.userId, userId))).catch(() => {});
  }
}

/** Monday is day 1 of the week and Sunday day 7, so a Sunday setting runs last. */
const isoDay = (d: number) => d || 7;

/**
 * Runs every enabled site whose weekday has arrived and whose ISO week still has unanswered pairs, one after another.
 * Failures stay on their site. Only runs that did work count toward `limit`.
 */
export async function drainVisibility(now = new Date(), limit = 5): Promise<{ processed: number; failed: number }> {
  const rows = await db.select({ userId: userSettings.userId, siteId: userSettings.siteId, raw: userSettings.aiVisibility, name: sites.name, domain: sites.domain })
    .from(userSettings).innerJoin(sites, and(eq(sites.id, userSettings.siteId), eq(sites.userId, userSettings.userId)))
    .where(sql`${userSettings.aiVisibility}->>'enabled' = 'true'`)
    // Least recently asked first: sites whose failed pairs retry every hour must not hold the per-pass limit.
    .orderBy(sql`(SELECT MAX(${aiAnswerChecks.askedAt}) FROM ${aiAnswerChecks} WHERE ${aiAnswerChecks.siteId} = ${sites.id} AND ${aiAnswerChecks.userId} = ${sites.userId}) ASC NULLS FIRST`);
  const week = isoWeek(now);
  const passStarted = Date.now();
  let processed = 0, failed = 0;
  for (const row of rows) {
    if (processed >= limit) break;
    const settings = normalizeVisibilitySettings(row.raw, row);
    if (!settings.questions.length || isoDay(now.getUTCDay()) < isoDay(settings.weekday)) continue;
    try {
      const failedSince = new Date(now.getTime() - FAILED_BACKOFF_MS);
      if (!(await pendingPairs(row.userId, row.siteId!, week, settings.questions, settings.engines, failedSince)).length) continue;
      // A pass can run for hours; the pass start would stamp the claim as already stale.
      const result = await runVisibility(row.userId, row.siteId!, { now: new Date(now.getTime() + Date.now() - passStarted), failedBackoffMs: FAILED_BACKOFF_MS });
      if (result.status === "done") processed += 1;
    } catch {
      failed += 1;
      console.error("[ai-visibility] Scheduled run failed", { siteId: row.siteId });
    }
  }
  return { processed, failed };
}
