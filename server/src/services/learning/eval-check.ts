import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { generationLogs, styleRules } from "../../db/schema.js";
import { engineAiEndpoint, type EngineLlm } from "../../engine/adapters/llm.js";
import { RUBRIC_DIMENSIONS, type RubricDimension } from "../../engine/evals/decide.js";
import { generateEngineArticle, judgePairwise, judgeRubric, type EvalDraft } from "../../engine/evals/run.js";
import { loadEvalBriefs, type EvalBrief } from "../../engine/evals/schema.js";
import { parseEngineSettings, resolveRunSettings } from "../../engine/modes.js";
import { getOpenRouterKey } from "../api-keys.js";
import { billedModel, resolveEngineModel, userEngineLlm } from "../engine-llm.js";
import { getEffectiveSettings } from "../user-settings.js";
import { rulesBlock } from "./rules.js";

export const EVAL_BRIEFS = 3;
/** A running check older than this is taken as dead (the worker restarted), so the rule can be tested again. */
export const EVAL_STALE_MS = 30 * 60_000;

export type EvalDeps = { llm: EngineLlm; draftModel: string; judgeModel: string; briefs?: EvalBrief[] };
export type RuleEval =
  | { status: "running"; startedAt: string }
  | { status: "failed"; error: string; finishedAt: string }
  | { status: "done"; winRate: number; meanDelta: number; dims: Record<RubricDimension, number>; wins: number; losses: number; ties: number; briefs: number; costUsd: number; finishedAt: string };

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function loadEvalDeps(userId: string, engineSettings: unknown): Promise<EvalDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new Error("OpenRouter is not configured");
  const { models } = resolveRunSettings("normal", parseEngineSettings(engineSettings));
  const [draftModel, judgeModel] = await Promise.all([resolveEngineModel(endpoint, models.draft), resolveEngineModel(endpoint, models.review)]);
  return { llm: await userEngineLlm(userId, endpoint), draftModel, judgeModel };
}

/** Marks the check as running; false when one is already running for this rule. */
export async function beginRuleEval(userId: string, ruleId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ eval: styleRules.eval }).from(styleRules).where(and(eq(styleRules.id, ruleId), eq(styleRules.userId, userId))).limit(1);
  const current = row?.eval as RuleEval | null;
  if (current?.status === "running" && now.getTime() - Date.parse(current.startedAt) < EVAL_STALE_MS) return false;
  await db.update(styleRules).set({ eval: { status: "running", startedAt: now.toISOString() } satisfies RuleEval }).where(and(eq(styleRules.id, ruleId), eq(styleRules.userId, userId)));
  return true;
}

/**
 * Advisory check of one proposed draft rule: the first 3 golden briefs are written by the site's draft model with and without the
 * rule, then judged by the site's review model, by rubric and pairwise. The summary lands on `style_rules.eval`; nothing is applied.
 */
export async function runRuleEval(input: { userId: string; ruleId: string; deps?: EvalDeps; now?: () => Date }): Promise<RuleEval> {
  const { userId, ruleId } = input;
  const now = input.now ?? (() => new Date());
  const [row] = await db.select().from(styleRules).where(and(eq(styleRules.id, ruleId), eq(styleRules.userId, userId))).limit(1);
  if (!row) throw new Error("rule not found");
  let spent = 0;
  let result: RuleEval;
  let judgeModel: string | null = null;
  try {
    const deps = input.deps ?? await loadEvalDeps(userId, (await getEffectiveSettings(userId, row.siteId)).engineSettings);
    judgeModel = deps.draftModel;
    const llm: EngineLlm = { async json(req) { try { const r = await deps.llm.json(req); spent += r.costUsd; return r; } catch (e) { spent += Number((e as { costUsd?: number })?.costUsd) || 0; throw e; } } };
    const briefs = (deps.briefs ?? await loadEvalBriefs()).slice(0, EVAL_BRIEFS);
    const block = rulesBlock([row.rule]);
    const verdicts: ("win" | "loss" | "tie")[] = [];
    const deltas: Record<RubricDimension, number>[] = [];
    for (const brief of briefs) {
      try {
        const write = async (styleRules?: string) => ({ ...(await generateEngineArticle(brief, "normal", llm, { now: now }, deps.draftModel, false, { styleRules })), briefId: brief.id, mode: "normal" }) as unknown as EvalDraft;
        const base = await write();
        const cand = await write(block);
        const [rb, rc] = await Promise.all([judgeRubric(llm, deps.judgeModel, brief, base, now()), judgeRubric(llm, deps.judgeModel, brief, cand, now())]);
        verdicts.push(await judgePairwise(llm, deps.judgeModel, brief, base, cand, now()));
        deltas.push(Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, rc[d] - rb[d]])) as Record<RubricDimension, number>);
      } catch (e) {
        // A brief that cannot be generated is skipped; the check fails only when none could be.
        console.error("[learning] Eval brief failed", (e as Error)?.name);
      }
    }
    if (!verdicts.length) throw new Error("No brief could be generated and judged");
    const count = (v: string) => verdicts.filter((x) => x === v).length;
    const dims = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, round3(mean(deltas.map((x) => x[d])))])) as Record<RubricDimension, number>;
    result = {
      status: "done", winRate: round3((count("win") + count("tie") / 2) / verdicts.length), meanDelta: round3(mean(RUBRIC_DIMENSIONS.map((d) => dims[d]))), dims,
      wins: count("win"), losses: count("loss"), ties: count("tie"), briefs: verdicts.length, costUsd: round3(spent), finishedAt: now().toISOString(),
    };
  } catch (e) {
    result = { status: "failed", error: String((e as Error)?.message ?? "failed").slice(0, 200), finishedAt: now().toISOString() };
  }
  await db.update(styleRules).set({ eval: result }).where(and(eq(styleRules.id, ruleId), eq(styleRules.userId, userId)));
  if (spent > 0 && judgeModel) {
    const model = billedModel(judgeModel);
    await db.insert(generationLogs).values({ userId, usageType: "text", modelId: model, provider: model.split("/")[0] ?? null, status: result.status === "done" ? "success" : "failed", cost: spent, responseData: { learningEval: true } })
      .catch(() => console.error("[learning] Could not log spend"));
  }
  return result;
}
