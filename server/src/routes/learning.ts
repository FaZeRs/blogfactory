import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { learningSignals } from "../db/schema.js";
import { engineAiEndpoint } from "../engine/adapters/llm.js";
import { ApiError, readJsonObject, safeError } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { persistentBackgroundExecution } from "../services/background-drain.js";
import { DISTILL, distillSite } from "../services/learning/distill.js";
import { beginRuleEval, runRuleEval } from "../services/learning/eval-check.js";
import { approveRule, getLearning, listRules, ownedRuleForEval, rejectRule, retireRule, saveLearning } from "../services/learning/rules.js";
import { ownedSite, UUID, validation } from "./owned-site.js";

export type LearningRouteDeps = {
  /** Where background work goes; tests collect the promises. */
  run?: (work: Promise<unknown>) => void;
  persistent?: () => boolean;
  hasKey?: (userId: string) => Promise<boolean>;
  distill?: typeof distillSite;
  evalRule?: typeof runRuleEval;
};

const inFlight = new Set<string>();

export function createLearningRoutes(deps: LearningRouteDeps = {}) {
  const run = deps.run ?? ((p) => waitUntil(p));
  const persistent = deps.persistent ?? persistentBackgroundExecution;
  const hasKey = deps.hasKey ?? (async (userId) => !!engineAiEndpoint(process.env, await getOpenRouterKey(userId)));
  const distill = deps.distill ?? distillSite;
  const evalRule = deps.evalRule ?? runRuleEval;
  const routes = new Hono();

  async function background(userId: string, what: string) {
    // A serverless function is cut off long before a model call ends; only the persistent worker host can carry it.
    if (!persistent()) throw new ApiError(400, "validation_error", `${what} needs the persistent background worker (BACKGROUND_EXECUTION_MODE=worker).`);
    if (!(await hasKey(userId))) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
  }

  function ruleId(c: Parameters<typeof getUserId>[0]) {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new ApiError(404, "not_found", "Rule not found");
    return id;
  }

  routes.get("/rules", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    return c.json(await listRules(userId, siteId));
  });

  routes.post("/rules/:id/approve", async (c) => {
    const userId = getUserId(c);
    const body = await c.req.json().catch(() => ({})) as { rule?: unknown };
    if (body.rule !== undefined && typeof body.rule !== "string") throw validation("rule", "rule must be text");
    return c.json({ rule: await approveRule(userId, ruleId(c), body.rule as string | undefined) });
  });
  routes.post("/rules/:id/reject", async (c) => c.json({ rule: await rejectRule(getUserId(c), ruleId(c)) }));
  routes.post("/rules/:id/retire", async (c) => c.json({ rule: await retireRule(getUserId(c), ruleId(c)) }));

  routes.post("/rules/:id/eval", async (c) => {
    const userId = getUserId(c);
    const id = ruleId(c);
    await ownedRuleForEval(userId, id);
    await background(userId, "Testing a rule");
    if (!(await beginRuleEval(userId, id))) throw new ApiError(409, "conflict", "This rule is already being tested");
    run(evalRule({ userId, ruleId: id }).catch((error) => { console.error("[learning] Eval failed", safeError(error)); }));
    return c.json({ started: true }, 202);
  });

  routes.post("/distill", async (c) => {
    const body = await readJsonObject(c).catch(() => ({} as Record<string, unknown>));
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId") ?? (typeof body.siteId === "string" ? body.siteId : undefined));
    await background(userId, "Suggesting rules");
    const key = `${userId}:${siteId}`;
    if (inFlight.has(key)) throw new ApiError(409, "conflict", "Rules are already being suggested");
    inFlight.add(key);
    run(distill({ userId, siteId }).catch((error) => { console.error("[learning] Distill failed", safeError(error)); }).finally(() => inFlight.delete(key)));
    return c.json({ started: true }, 202);
  });

  routes.get("/settings", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const since = new Date(Date.now() - DISTILL.windowDays * 86_400_000);
    const [[signals], settings] = await Promise.all([
      db.select({ n: count() }).from(learningSignals).where(and(eq(learningSignals.userId, userId), eq(learningSignals.siteId, siteId), gte(learningSignals.createdAt, since))),
      getLearning(userId, siteId),
    ]);
    return c.json({ ...settings, signals: signals?.n ?? 0 });
  });

  routes.put("/settings", async (c) => {
    const body = await readJsonObject(c);
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId") ?? (typeof body.siteId === "string" ? body.siteId : undefined));
    if (typeof body.enabled !== "boolean") throw validation("enabled", "enabled must be true or false");
    return c.json(await saveLearning(userId, siteId, { enabled: body.enabled }));
  });

  return routes;
}

export const learningRoutes = createLearningRoutes();
