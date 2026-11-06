import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { styleRules } from "../../db/schema.js";
import { fenceData } from "../../engine/prompts/load.js";
import { ApiError } from "../../http/error-contract.js";
import { getEffectiveSettings, updateSiteSettings } from "../user-settings.js";

export const RULE_MAX = 200;
export const INJECT = { rules: 30, ruleChars: 300 } as const;
export const NO_RULES = "None yet.";

export type StyleRuleRow = typeof styleRules.$inferSelect;

/** `draft` or `translation:<locale>`. */
export const SCOPE_RE = /^(draft|translation:[a-z]{2}(-[A-Z]{2})?)$/;
export const translationScope = (locale: string) => `translation:${locale}`;

/**
 * The approved rules of one scope as a fenced `style-rules` block for a prompt, or "None yet.": whitespace collapsed,
 * each rule capped at 300 characters, the newest 30. Scoped to the user and site.
 */
export async function styleRulesText(userId: string, siteId: string, scope: string): Promise<string> {
  const rows = await db.select({ rule: styleRules.rule }).from(styleRules)
    .where(and(eq(styleRules.userId, userId), eq(styleRules.siteId, siteId), eq(styleRules.scope, scope), eq(styleRules.status, "approved"), eq(styleRules.op, "add")))
    .orderBy(desc(styleRules.decidedAt), desc(styleRules.createdAt)).limit(INJECT.rules);
  return rulesBlock(rows.map((r) => r.rule));
}

/** The prompt text for a list of rules; the eval check uses it for a candidate rule that is not approved yet. */
export function rulesBlock(rules: string[]): string {
  const lines = rules.map((r) => r.replace(/\s+/g, " ").trim().slice(0, INJECT.ruleChars)).filter(Boolean);
  return lines.length ? fenceData("style-rules", lines.map((l) => `- ${l}`).join("\n")) : NO_RULES;
}

export type LearningSettings = { enabled: boolean; lastDistillAt: string | null };

export async function getLearning(userId: string, siteId: string): Promise<LearningSettings> {
  const raw = (await getEffectiveSettings(userId, siteId)).learning as { enabled?: unknown; lastDistillAt?: unknown } | null | undefined;
  return { enabled: raw?.enabled === true, lastDistillAt: typeof raw?.lastDistillAt === "string" ? raw.lastDistillAt : null };
}

export async function saveLearning(userId: string, siteId: string, patch: Partial<LearningSettings>): Promise<LearningSettings> {
  const next = { ...(await getLearning(userId, siteId)), ...patch };
  await updateSiteSettings(userId, siteId, { learning: next });
  return next;
}

const notFound = () => new ApiError(404, "not_found", "Rule not found");

async function ownedRule(userId: string, id: string): Promise<StyleRuleRow> {
  const [row] = await db.select().from(styleRules).where(and(eq(styleRules.id, id), eq(styleRules.userId, userId))).limit(1);
  if (!row) throw notFound();
  return row;
}

export async function listRules(userId: string, siteId: string) {
  const rows = await db.select().from(styleRules).where(and(eq(styleRules.userId, userId), eq(styleRules.siteId, siteId))).orderBy(desc(styleRules.createdAt)).limit(300);
  // An approved retire proposal is only the act of retiring its target: the target is listed, not the act.
  const by = (status: string) => rows.filter((r) => r.status === status && (r.op === "add" || status === "proposed" || status === "rejected")).map(serializeRule);
  return { proposed: by("proposed"), approved: by("approved"), retired: by("retired"), rejected: by("rejected") };
}

export function serializeRule(r: StyleRuleRow) {
  return { id: r.id, scope: r.scope, rule: r.rule, rationale: r.rationale, op: r.op, targetRuleId: r.targetRuleId, status: r.status, evidence: r.evidence, eval: r.eval, createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null };
}

/** Approves a proposal, optionally with the owner's edited text. A retire proposal retires its target instead. */
export async function approveRule(userId: string, id: string, edited?: string) {
  const row = await ownedRule(userId, id);
  if (row.status !== "proposed") throw new ApiError(409, "conflict", `A ${row.status} rule cannot be approved`);
  const rule = edited === undefined ? row.rule : edited.replace(/\s+/g, " ").trim();
  if (!rule || rule.length > RULE_MAX) throw new ApiError(400, "validation_error", `A rule is 1–${RULE_MAX} characters`, [{ field: "rule", message: `Use 1–${RULE_MAX} characters` }]);
  const now = new Date();
  return db.transaction(async (tx) => {
    if (row.op === "retire") {
      const [target] = row.targetRuleId
        ? await tx.update(styleRules).set({ status: "retired", decidedAt: now })
          .where(and(eq(styleRules.id, row.targetRuleId), eq(styleRules.userId, userId), eq(styleRules.siteId, row.siteId), eq(styleRules.status, "approved"))).returning({ id: styleRules.id })
        : [];
      if (!target) throw new ApiError(409, "conflict", "The rule to retire is no longer approved");
    }
    const [updated] = await tx.update(styleRules).set({ status: "approved", decidedAt: now, ...(row.op === "add" ? { rule } : {}) })
      .where(and(eq(styleRules.id, id), eq(styleRules.userId, userId), eq(styleRules.status, "proposed"))).returning();
    if (!updated) throw new ApiError(409, "conflict", "This rule was already decided");
    return serializeRule(updated);
  });
}

async function move(userId: string, id: string, from: string, to: "rejected" | "retired") {
  const row = await ownedRule(userId, id);
  if (row.status !== from) throw new ApiError(409, "conflict", `A ${row.status} rule cannot be ${to === "retired" ? "retired" : "rejected"}`);
  const [updated] = await db.update(styleRules).set({ status: to, decidedAt: new Date() })
    .where(and(eq(styleRules.id, id), eq(styleRules.userId, userId), eq(styleRules.status, from))).returning();
  if (!updated) throw new ApiError(409, "conflict", "This rule was already decided");
  return serializeRule(updated);
}

export const rejectRule = (userId: string, id: string) => move(userId, id, "proposed", "rejected");
export const retireRule = (userId: string, id: string) => move(userId, id, "approved", "retired");

export async function ownedRuleForEval(userId: string, id: string) {
  const row = await ownedRule(userId, id);
  if (row.status !== "proposed" || row.op !== "add") throw new ApiError(409, "conflict", "Only a proposed new rule can be tested");
  if (row.scope !== "draft") throw new ApiError(400, "validation_error", "Evals cover English draft rules only");
  return row;
}

export async function pendingCount(userId: string, siteId: string) {
  const rows = await db.select({ id: styleRules.id }).from(styleRules)
    .where(and(eq(styleRules.userId, userId), eq(styleRules.siteId, siteId), inArray(styleRules.status, ["proposed"])));
  return rows.length;
}
