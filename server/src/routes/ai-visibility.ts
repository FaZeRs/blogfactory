import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { ApiError, readJsonObject, requiredString } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { ENGINE_ID, ENGINE_LABELS, MAX_ENGINES, getVisibilitySettings, normalizeVisibilitySettings, saveVisibilitySettings } from "../services/ai-visibility/settings.js";
import { runVisibility, visibilityRunning } from "../services/ai-visibility/run.js";
import { SuggestBlockedError, suggestQuestions, validateQuestions } from "../services/ai-visibility/questions.js";
import { visibilitySummary } from "../services/ai-visibility/summary.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { persistentBackgroundExecution } from "../services/background-drain.js";
import { addManualIdea } from "../services/ideas/manual.js";
import { serializeIdea } from "../services/ideas/actions.js";
import { getOpenRouterModels } from "../services/openrouter-models.js";
import { ownedSite, validation } from "./owned-site.js";



/** OpenRouter text models that bill web search, from the providers we label, without batch variants. */
export const searchModels = (models: any[]) => models
  .filter((m) => m.rawPricing?.webSearch > 0 && !m.id.includes(":batch") && Object.hasOwn(ENGINE_LABELS, m.id.split("/")[0] ?? ""))
  .map((m) => ({ id: m.id as string, label: (m.name || m.id) as string, searchPrice: m.rawPricing.webSearch as number }));

export function createAiVisibilityRoutes() {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const hasKey = !!(await getOpenRouterKey(userId));
    const reason = hasKey ? undefined : process.env.ENGINE_AI_BASE_URL?.trim() ? "custom_gateway" as const : "no_openrouter_key" as const;
    const [settings, summary, running] = await Promise.all([getVisibilitySettings(userId, siteId), visibilitySummary(userId, siteId), visibilityRunning(userId, siteId)]);
    return c.json({ available: hasKey, ...(reason ? { reason } : {}), settings, summary, running });
  });

  routes.put("/settings", async (c) => {
    const body = await readJsonObject(c);
    const { userId, siteId, site } = await ownedSite(c, requiredString(body, "siteId"));
    const input = body.settings;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw validation("settings", "Settings are required");
    const raw = input as Record<string, unknown>;
    if (raw.engines !== undefined) {
      const engines = raw.engines;
      if (!Array.isArray(engines) || !engines.length || engines.length > MAX_ENGINES || !engines.every((e) => typeof e === "string" && ENGINE_ID.test(e))) {
        throw validation("settings.engines", `Choose 1 to ${MAX_ENGINES} models as provider/model ids`);
      }
    }
    const { brandTerms } = normalizeVisibilitySettings(raw, site);
    const { questions, errors } = validateQuestions(raw.questions, brandTerms);
    if (errors.length) return c.json({ error: "Some questions need changes", errors }, 400);
    return c.json({ settings: await saveVisibilitySettings(userId, siteId, { ...raw, questions }) });
  });

  routes.post("/suggest", async (c) => {
    const { userId, siteId } = await ownedSite(c, requiredString(await readJsonObject(c), "siteId"));
    if (!(await getOpenRouterKey(userId))) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
    try {
      return c.json({ questions: await suggestQuestions(userId, siteId, undefined, c.req.raw.signal) });
    } catch (error) {
      if (error instanceof SuggestBlockedError) throw new ApiError(400, "validation_error", error.message);
      // The LLM adapter reports the status only; 402 is OpenRouter's out-of-credits answer.
      if (error instanceof Error && /HTTP 402/.test(error.message)) throw new ApiError(400, "validation_error", "OpenRouter is out of credits. Top up the key in OpenRouter, then try again.");
      throw error;
    }
  });

  routes.post("/run", async (c) => {
    const { userId, siteId } = await ownedSite(c, requiredString(await readJsonObject(c), "siteId"));
    if (await visibilityRunning(userId, siteId)) throw new ApiError(409, "conflict", "A check is already running");
    if (!(await getVisibilitySettings(userId, siteId)).questions.length) throw validation("questions", "Add questions first");
    if (!(await getOpenRouterKey(userId))) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
    // A serverless function is cut off long before a run of minutes ends; only the persistent worker host can carry it.
    if (!persistentBackgroundExecution()) throw new ApiError(400, "validation_error", "Run now needs the persistent background worker (BACKGROUND_EXECUTION_MODE=worker).");
    // Detached: the check takes minutes. Errors are logged without bodies; the weekly drain is the scheduled path.
    const started = runVisibility(userId, siteId).catch(() => { console.error("[ai-visibility] Manual run failed"); return null; });
    waitUntil(started);
    // A skipped run returns before its first engine call (which takes seconds), so the button can say why.
    const early = await Promise.race([started, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    if (early?.status === "capped") {
      throw new ApiError(400, "validation_error", `This check would cost about $${early.estimateUsd.toFixed(2)}; $${early.spentUsd.toFixed(2)} of the $${early.capUsd.toFixed(2)} monthly cap is spent. Raise the cap in Settings.`);
    }
    if (early?.status === "blocked") throw new ApiError(400, "validation_error", early.message);
    if (early?.status === "running") throw new ApiError(409, "conflict", "A check is already running");
    if (early?.status === "done" && early.asked === 0) return c.json({ started: false, message: "This week's check is already complete" });
    return c.json({ started: true }, 202);
  });

  routes.get("/models", async (c) => {
    const userId = getUserId(c);
    const apiKey = await getOpenRouterKey(userId);
    if (!apiKey) throw new ApiError(400, "validation_error", "Add an OpenRouter API key first");
    return c.json({ models: searchModels(await getOpenRouterModels(apiKey, "text")) });
  });

  routes.post("/gap-idea", async (c) => {
    const body = await readJsonObject(c);
    const { userId, siteId } = await ownedSite(c, requiredString(body, "siteId"));
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 160) : "";
    if (question.length < 5) throw validation("question", "A question of at least 5 characters is required");
    return c.json({ idea: serializeIdea(await addManualIdea({ userId, siteId, title: question })) }, 201);
  });

  return routes;
}

export const aiVisibilityRoutes = createAiVisibilityRoutes();
