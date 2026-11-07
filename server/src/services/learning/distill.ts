import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { generationLogs, learningSignals, styleRules, userSettings } from "../../db/schema.js";
import { engineAiEndpoint, type EngineLlm } from "../../engine/adapters/llm.js";
import { parseEngineSettings, resolveRunSettings } from "../../engine/modes.js";
import { DATA_RULE, fenceData, preparePrompt } from "../../engine/prompts/load.js";
import { sanitizeText } from "../../engine/util.js";
import { getOpenRouterKey } from "../api-keys.js";
import { billedModel, resolveEngineModel, userEngineLlm } from "../engine-llm.js";
import { checkAccountGuardrails } from "../account-guardrails.js";
import { similarity, tokens } from "../ideas/novelty.js";
import { finishOperationEvent, startOperationEvent } from "../operation-events.js";
import { getEffectiveSettings } from "../user-settings.js";
import { LOCALE_RE } from "../localization/settings.js";
import { RULE_MAX, SCOPE_RE, getLearning, saveLearning } from "./rules.js";

export const DISTILL = { windowDays: 28, minSignals: 2, maxPending: 5, maxRules: 5, similarity: 0.8, signals: 150, excerpt: 160 } as const;

export type DistillDeps = { llm: EngineLlm; model: string };
export type DistillResult = { skipped?: "signals" | "pending" | "guardrails"; signals: number; proposals: number; costUsd: number };

const ReplySchema = z.object({
  rules: z.array(z.object({
    op: z.enum(["add", "retire"]),
    scope: z.string(),
    rule: z.string(),
    rationale: z.string().default(""),
    evidence: z.array(z.string()).default([]),
    targetRuleId: z.string().nullish(),
  })),
});

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const clip = (s: string, n: number = DISTILL.excerpt) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function loadDistillDeps(userId: string, engineSettings: unknown): Promise<DistillDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new Error("OpenRouter is not configured");
  const model = await resolveEngineModel(endpoint, resolveRunSettings("normal", parseEngineSettings(engineSettings)).models.brief);
  return { llm: await userEngineLlm(userId, endpoint), model };
}

type Signal = typeof learningSignals.$inferSelect;

/** One line a model can read: the signal's id, kind, scope and what the owner changed or wrote. Signal text is the owner's, but fenced as data anyway. */
function signalLine(id: string, s: Signal) {
  const p = s.payload as { text?: string; hunks?: { before: string; after: string }[]; editRatio?: number };
  const scope = s.locale ? `translation:${s.locale}` : "draft";
  const what = s.kind === "comment"
    ? sanitizeText(p.text ?? "").replace(/\s+/g, " ")
    : (p.hunks ?? []).slice(0, 12).map((h) => `"${sanitizeText(h.before)}" -> "${sanitizeText(h.after)}"`).join("; ");
  return `${id} | ${s.kind} | ${scope} | ${clip(what, 900)}`;
}

// Words match on a shared prefix of 3 to 5 letters, so inflected forms (jūs, jūsu; rinda, rindas) still match.
const near = (a: string, b: string) => { const n = Math.min(a.length, b.length, 5); return n >= 3 && a.slice(0, n) === b.slice(0, n); };

/** The part of the signal (a comment line or an edit hunk) that shares the most words with the rule; the first part on a tie. */
export function excerptOf(s: Pick<Signal, "kind" | "payload">, rule: string) {
  const p = s.payload as { text?: string; hunks?: { before: string; after: string }[] };
  const parts = s.kind === "comment"
    ? (p.text ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean)
    : (p.hunks ?? []).map((h) => `${h.before} -> ${h.after}`);
  const want = [...new Set(tokens(rule))];
  let best = parts[0] ?? "";
  let score = 0;
  for (const part of parts) {
    const n = [...new Set(tokens(part))].filter((t) => want.some((w) => near(t, w))).length;
    if (n > score) { best = part; score = n; }
  }
  return clip(best);
}

/**
 * Reads the last 28 days of signals and proposes up to 5 rules for the owner to approve. Skips with fewer than 2 signals or when 5
 * proposals already wait. Writes the `learning.distill` operation event with counts only. Scoped to the user and site.
 */
export async function distillSite(input: { userId: string; siteId: string; deps?: DistillDeps; now?: Date }): Promise<DistillResult> {
  const { userId, siteId } = input;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - DISTILL.windowDays * 86_400_000);
  const [signals, rules] = await Promise.all([
    db.select().from(learningSignals).where(and(eq(learningSignals.userId, userId), eq(learningSignals.siteId, siteId), gte(learningSignals.createdAt, since)))
      .orderBy(desc(learningSignals.createdAt)).limit(DISTILL.signals),
    db.select().from(styleRules).where(and(eq(styleRules.userId, userId), eq(styleRules.siteId, siteId))).orderBy(desc(styleRules.createdAt)).limit(300),
  ]);
  const waiting = rules.filter((r) => r.status === "proposed");
  if (signals.length < DISTILL.minSignals) return { skipped: "signals", signals: signals.length, proposals: 0, costUsd: 0 };
  if (waiting.length >= DISTILL.maxPending) return { skipped: "pending", signals: signals.length, proposals: 0, costUsd: 0 };
  // A paused account, or one over its daily or monthly limit, makes no model calls; the weekly task tries again next week.
  if ((await checkAccountGuardrails(userId, now)).blocked) return { skipped: "guardrails", signals: signals.length, proposals: 0, costUsd: 0 };

  const started = Date.now();
  const eventId = await startOperationEvent({ userId, siteId, origin: "system", action: "learning.distill", objectType: "site", objectId: siteId });
  let costUsd = 0;
  let model: string | null = null;
  let ok = false;
  let proposals = 0;
  try {
    const deps = input.deps ?? await loadDistillDeps(userId, (await getEffectiveSettings(userId, siteId)).engineSettings);
    model = deps.model;
    const ids = new Map(signals.map((s, i) => [`s${i + 1}`, s]));
    const approved = rules.filter((r) => r.status === "approved" && r.op === "add");
    const prompt = await preparePrompt("learning-distill", {
      dataRule: DATA_RULE,
      ruleMax: RULE_MAX,
      maxRules: DISTILL.maxRules,
      signals: fenceData("signals", [...ids].map(([id, s]) => signalLine(id, s)).join("\n")),
      approved: fenceData("approved-rules", approved.map((r) => `${r.id} | ${r.scope} | ${r.rule}`).join("\n") || "(none)"),
      waiting: fenceData("waiting-rules", waiting.map((r) => `${r.scope} | ${r.rule}`).join("\n") || "(none)"),
    });
    const r = await deps.llm.json({ role: "brief", model: deps.model, system: prompt.system, user: prompt.user, schema: ReplySchema, maxTokens: 4000 });
    costUsd = r.costUsd;

    // A rule the owner rejected is not proposed again.
    const taken = rules.filter((x) => x.status !== "retired" && x.op === "add");
    const retiring = new Set(waiting.filter((x) => x.op === "retire").map((x) => x.targetRuleId));
    const room = DISTILL.maxPending - waiting.length;
    const rows: (typeof styleRules.$inferInsert)[] = [];
    for (const p of r.value.rules.slice(0, 30)) {
      if (rows.length >= room) break;
      const text = p.rule.replace(/\s+/g, " ").trim();
      const evidence = [...new Set(p.evidence)].flatMap((id) => (ids.has(id) ? [ids.get(id)!] : []));
      const evidenceJson = evidence.map((s) => ({ signalId: s.id, kind: s.kind, locale: s.locale, excerpt: excerptOf(s, `${text} ${p.rationale}`) }));
      if (p.op === "retire") {
        const target = approved.find((a) => a.id === p.targetRuleId);
        // A retire proposal for something that is not an approved rule, or already proposed, is dropped.
        if (!target || retiring.has(target.id)) continue;
        retiring.add(target.id);
        rows.push({ userId, siteId, scope: target.scope, rule: target.rule, rationale: p.rationale.trim().slice(0, 400), op: "retire", targetRuleId: target.id, evidence: evidenceJson });
        continue;
      }
      if (!text || text.length > RULE_MAX || !SCOPE_RE.test(p.scope) || (p.scope !== "draft" && !LOCALE_RE.test(p.scope.slice(12))) || evidence.length < 2) continue;
      if (taken.some((x) => x.scope === p.scope && (norm(x.rule) === norm(text) || similarity(x.rule, text) >= DISTILL.similarity))) continue;
      taken.push({ scope: p.scope, rule: text } as (typeof taken)[number]);
      rows.push({ userId, siteId, scope: p.scope, rule: text, rationale: p.rationale.trim().slice(0, 400), op: "add", evidence: evidenceJson });
    }
    if (rows.length) await db.insert(styleRules).values(rows);
    proposals = rows.length;
    ok = true;
    return { signals: signals.length, proposals, costUsd };
  } catch (error) {
    costUsd += Number((error as { costUsd?: number })?.costUsd) || 0;
    throw error;
  } finally {
    await finishOperationEvent({ id: eventId, status: ok ? "succeeded" : "failed", durationMs: Date.now() - started, siteId, metadata: { signal_count: signals.length, proposal_count: proposals, cost_usd: costUsd } }).catch(() => {});
    if (costUsd > 0 && model) {
      const billed = billedModel(model);
      await db.insert(generationLogs).values({
        userId, usageType: "text", modelId: billed, provider: billed.split("/")[0] ?? null, status: ok ? "success" : "failed", cost: costUsd, responseData: { learningDistill: true },
      }).catch(() => console.error("[learning] Could not log spend"));
    }
  }
}

const WEEK_MS = 6.5 * 86_400_000;

/** The weekly worker task: every site with learning on, on Sunday (UTC), at most once a week. A site's failure does not stop the others. */
export async function drainWeeklyDistill(now = new Date(), deps?: DistillDeps): Promise<{ sites: number; proposals: number; failed: number }> {
  if (now.getUTCDay() !== 0) return { sites: 0, proposals: 0, failed: 0 };
  const rows = await db.select({ userId: userSettings.userId, siteId: userSettings.siteId }).from(userSettings).where(isNotNull(userSettings.learning));
  const out = { sites: 0, proposals: 0, failed: 0 };
  for (const row of rows) {
    if (!row.siteId) continue;
    try {
      const l = await getLearning(row.userId, row.siteId);
      if (!l.enabled || (l.lastDistillAt && now.getTime() - Date.parse(l.lastDistillAt) < WEEK_MS)) continue;
      out.sites += 1;
      const r = await distillSite({ userId: row.userId, siteId: row.siteId, deps, now });
      out.proposals += r.proposals;
      await saveLearning(row.userId, row.siteId, { lastDistillAt: now.toISOString() });
    } catch {
      out.failed += 1;
      console.error("[learning] Weekly distill failed for a site");
    }
  }
  return out;
}
