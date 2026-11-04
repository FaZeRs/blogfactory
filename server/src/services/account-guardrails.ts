import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationLogs } from "../db/schema.js";
import { evaluateDailyGuardrails, type GuardrailLimits, type GuardrailUsage } from "./generation-guardrails.js";
import { getGlobalSettings, updateGlobalSettings } from "./user-settings.js";

export type GuardrailDecision =
  | { blocked: false }
  | { blocked: true; message: string; error: string; latchMonthly: boolean };

type AccountLimits = GuardrailLimits & { budgetPaused?: boolean | null };

/** Pure policy: paused latch, then monthly budget (latches), then daily ceilings (do not latch). */
export function guardrailDecision(settings: AccountLimits | null | undefined, usage: GuardrailUsage): GuardrailDecision {
  if (settings?.budgetPaused) {
    return { blocked: true, message: "Generation paused — monthly budget exceeded", error: "Budget exceeded", latchMonthly: false };
  }
  if (settings?.monthlyBudget && usage.monthSpend >= settings.monthlyBudget) {
    return { blocked: true, message: "Monthly budget exceeded — generation paused", error: "Budget exceeded", latchMonthly: true };
  }
  const daily = settings ? evaluateDailyGuardrails(settings, usage) : null;
  if (daily) return { blocked: true, message: daily.message, error: daily.message, latchMonthly: false };
  return { blocked: false };
}

/** Reads usage, applies the account guardrails, and latches `budgetPaused` on a monthly overrun. */
export async function checkAccountGuardrails(userId: string, now = new Date()): Promise<GuardrailDecision> {
  const settings = await getGlobalSettings(userId);
  const usage: GuardrailUsage = { monthSpend: 0, todaySpend: 0, todayRequests: 0, todayFailures: 0 };

  if (settings?.monthlyBudget && !settings.budgetPaused) {
    const startOfMonth = new Date(now);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const [row] = await db.select({ total: sql<number>`COALESCE(SUM(cost), 0)` })
      .from(generationLogs)
      .where(and(eq(generationLogs.userId, userId), sql`created_at >= ${startOfMonth.toISOString()}`));
    usage.monthSpend = row?.total || 0;
  }

  if (settings?.dailyCostLimit || settings?.dailyRequestLimit) {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [row] = await db.select({
      spend: sql<number>`COALESCE(SUM(${generationLogs.cost}), 0)::float8`,
      requests: sql<number>`COUNT(*)::int`,
      failures: sql<number>`COUNT(*) FILTER (WHERE ${generationLogs.status} IS NOT NULL AND ${generationLogs.status} <> 'success')::int`,
    })
      .from(generationLogs)
      .where(and(eq(generationLogs.userId, userId), gte(generationLogs.createdAt, startOfDay)));
    usage.todaySpend = Number(row?.spend || 0);
    usage.todayRequests = Number(row?.requests || 0);
    usage.todayFailures = Number(row?.failures || 0);
  }

  const decision = guardrailDecision(settings, usage);
  if (decision.blocked && decision.latchMonthly) await updateGlobalSettings(userId, { budgetPaused: true });
  return decision;
}
