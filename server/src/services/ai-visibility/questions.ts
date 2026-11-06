import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { generationLogs, ideas } from "../../db/schema.js";
import { createEngineLlm, engineAiEndpoint, type EngineLlm } from "../../engine/adapters/llm.js";
import { parseEngineSettings, resolveRunSettings } from "../../engine/modes.js";
import { checkAccountGuardrails } from "../account-guardrails.js";
import { getOpenRouterKey } from "../api-keys.js";
import { effectiveSeedTopics, getIdeaSettings } from "../ideas/settings.js";
import { resolveOpenRouterTextModel } from "../openrouter-models.js";
import { getEffectiveSettings, getSiteForUser } from "../user-settings.js";
import { mentions } from "./detect.js";
import { getVisibilitySettings, MAX_QUESTIONS } from "./settings.js";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export const questionHash = (q: string) => createHash("sha256").update(collapse(q).toLowerCase()).digest("hex");

export type QuestionError = { index: number; message: string };

/** Cleans the list and reports problems by input index. Blank entries are dropped silently. */
export function validateQuestions(list: unknown, brandTerms: string[]): { questions: string[]; errors: QuestionError[] } {
  const questions: string[] = [];
  const errors: QuestionError[] = [];
  const seen = new Set<string>();
  (Array.isArray(list) ? list : []).forEach((raw, index) => {
    if (typeof raw !== "string") return void errors.push({ index, message: "Not text" });
    let q = collapse(raw);
    if (!q) return;
    if (!q.endsWith("?")) q += "?";
    const fail = (message: string) => void errors.push({ index, message });
    if (q.length < 5) return fail("Too short (5 characters minimum)");
    if (q.length > 200) return fail("Too long (200 characters maximum)");
    if (mentions(q, brandTerms)) return fail("Names the brand; ask the way a customer who doesn't know it would");
    const key = q.toLowerCase();
    if (seen.has(key)) return fail("Duplicate question");
    if (questions.length >= MAX_QUESTIONS) return fail(`At most ${MAX_QUESTIONS} questions`);
    seen.add(key);
    questions.push(q);
  });
  return { questions, errors };
}

const QUESTION_START = /^(how|what|why|when|where|which|who|whom|whose|can|could|should|would|will|is|are|do|does|did|am|has|have)\s/i;

export type SuggestDeps = {
  llm: EngineLlm;
  model: string;
  gscQueries?: () => Promise<string[]>;
  ideaQuestions?: () => Promise<string[]>;
};

async function readGscQuestions(userId: string, siteId: string): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT query FROM search_console_metrics
    WHERE user_id = ${userId}::uuid AND site_id = ${siteId}::uuid AND date >= ${since}
    GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 200`);
  return (rows as unknown as { query: string }[]).map((r) => r.query)
    .filter((q) => q.includes("?") || QUESTION_START.test(q.trim())).slice(0, 30);
}

async function readIdeaQuestions(userId: string, siteId: string): Promise<string[]> {
  const rows = await db.select({ q: ideas.audienceQuestion }).from(ideas)
    .where(and(eq(ideas.userId, userId), eq(ideas.siteId, siteId), isNotNull(ideas.audienceQuestion)))
    .orderBy(desc(ideas.createdAt)).limit(20);
  return rows.flatMap((r) => (r.q?.trim() ? [r.q.trim()] : []));
}

async function loadSuggestDeps(userId: string, engineSettings: unknown): Promise<SuggestDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new Error("OpenRouter is not configured");
  let model = resolveRunSettings("normal", parseEngineSettings(engineSettings)).models.brief;
  if (endpoint.gateway === "openrouter") model = await resolveOpenRouterTextModel(endpoint.apiKey, model);
  return { llm: createEngineLlm(endpoint), model };
}

const replySchema = z.object({ questions: z.array(z.string()) });

/** The account guardrails block new spend; the message is safe to show. */
export class SuggestBlockedError extends Error {}

/** One model call over Search Console questions, idea audience questions and seed topics. Up to 20, already validated. */
export async function suggestQuestions(userId: string, siteId: string, deps?: SuggestDeps): Promise<string[]> {
  const site = await getSiteForUser(userId, siteId);
  if (!site) throw new Error("Site not found");
  const guard = await checkAccountGuardrails(userId);
  if (guard.blocked) throw new SuggestBlockedError(guard.message);
  const [settings, effective, idea] = await Promise.all([
    getVisibilitySettings(userId, siteId), getEffectiveSettings(userId, siteId), getIdeaSettings(userId, siteId),
  ]);
  const d = deps ?? await loadSuggestDeps(userId, effective.engineSettings);
  const [gsc, audience] = await Promise.all([
    (d.gscQueries ?? (() => readGscQuestions(userId, siteId)))().catch(() => []),
    (d.ideaQuestions ?? (() => readIdeaQuestions(userId, siteId)))().catch(() => []),
  ]);
  const topics = effectiveSeedTopics(idea, site);
  const lines = (title: string, items: string[]) => items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";
  let costUsd = 0;
  let ok = false;
  try {
    const res = await d.llm.json({
      role: "brief",
      model: d.model,
      maxTokens: 1500,
      schema: replySchema,
      system: "You write the questions real customers type into an AI assistant such as ChatGPT or Perplexity when they look for a product, service or answer. Never name the brand, company or its domain.",
      user: [
        `Site: ${site.name} (${site.domain}). Language: ${site.language || "en"}.`,
        effective.brandDescription ? `About: ${effective.brandDescription}` : "",
        effective.brandTargetAudience ? `Audience: ${effective.brandTargetAudience}` : "",
        lines("Topics", topics),
        lines("Questions people searched on Google", gsc),
        lines("Questions the audience asks", audience),
        "Write 20 distinct questions in the site's language. Each is one natural sentence ending with a question mark, 5 to 200 characters, and does not contain the brand.",
      ].filter(Boolean).join("\n"),
    });
    costUsd = res.costUsd;
    ok = true;
    return validateQuestions(res.value.questions, settings.brandTerms).questions
      .filter((q) => !settings.questions.some((e) => e.toLowerCase() === q.toLowerCase())).slice(0, 20);
  } catch (error) {
    costUsd += Number((error as { costUsd?: number })?.costUsd) || 0;
    throw error;
  } finally {
    if (costUsd > 0) {
      await db.insert(generationLogs).values({
        userId, usageType: "text", modelId: d.model, provider: d.model.split("/")[0] ?? null, status: ok ? "success" : "failed", cost: costUsd,
        responseData: { aiVisibility: { siteId, suggest: true } },
      }).catch(() => console.error("[ai-visibility] Could not log suggestion spend"));
    }
  }
}
