import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { articleEvidence, articleRuns, generationLogs, posts } from "../db/schema.js";
import { engineAiEndpoint, type EngineLlm } from "../engine/adapters/llm.js";
import { ENGINE_CONFIG } from "../engine/config.js";
import { parseEngineSettings, resolveRunSettings } from "../engine/modes.js";
import { DATA_RULE, fenceData, preparePrompt } from "../engine/prompts/load.js";
import { normalizeDraftMarkdown } from "../engine/stages/shared.js";
import { RateLimitError } from "../engine/types.js";
import { sanitizeText } from "../engine/util.js";
import { ApiError } from "../http/error-contract.js";
import { checkAccountGuardrails } from "./account-guardrails.js";
import { getOpenRouterKey } from "./api-keys.js";
import { finishOperationEvent, startOperationEvent } from "./operation-events.js";
import { NO_RULES, styleRulesText } from "./learning/rules.js";
import { recordCommentSignal } from "./learning/signals.js";
import { cleanGeneratedPostContent, cleanPostTitle } from "./post-cleanup.js";
import { PostVersionConflictError, updatePostWithRevision } from "./post-revisions.js";
import { getEffectiveSettings } from "./user-settings.js";
import { buildVoiceContentInstructions } from "./voice-content.js";
import { INTERACTIVE_TIMEOUT_MS, billedModel, resolveEngineModel, userEngineLlm } from "./engine-llm.js";

export const COMMENTS_MIN = 10;
export const COMMENTS_MAX = 4000;
export type ReviseDeps = { llm: EngineLlm; model: string };

const ReplySchema = z.object({ title: z.string().min(5), description: z.string().min(20), markdown: z.string().min(200) });
const STALE = "This post changed since you opened it. Reload it, then revise again.";

async function loadDeps(userId: string, engineSettings: unknown): Promise<ReviseDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new ApiError(503, "service_unavailable", "Add an OpenRouter key in Integrations to revise with AI.");
  let model = resolveRunSettings("normal", parseEngineSettings(engineSettings)).models.revise;
  model = await resolveEngineModel(endpoint, model);
  return { llm: await userEngineLlm(userId, endpoint, { timeoutMs: INTERACTIVE_TIMEOUT_MS }), model };
}

/** The run that wrote this post (`article_runs.post_id`, set at delivery) gives the verified evidence; hand-made posts have none. */
async function runEvidence(userId: string, siteId: string | null, postId: string) {
  // A run always has a site, so a post without one has no run.
  if (!siteId) return "";
  const [run] = await db.select({ id: articleRuns.id }).from(articleRuns)
    .where(and(eq(articleRuns.postId, postId), eq(articleRuns.userId, userId), eq(articleRuns.siteId, siteId))).limit(1);
  if (!run) return "";
  const rows = await db.select({ claim: articleEvidence.claim, quote: articleEvidence.quote }).from(articleEvidence)
    .where(and(eq(articleEvidence.runId, run.id), eq(articleEvidence.userId, userId), eq(articleEvidence.verified, true))).limit(60);
  return rows.map((e) => `- ${e.claim}\n    quote: "${e.quote}"`).join("\n");
}

/** One model call rewrites the post from the owner's comments; it saves as a new revision under the same lock as an edit. */
export async function reviseWithComments(input: { userId: string; postId: string; comments: string; expectedUpdatedAt: Date; deps?: ReviseDeps; signal?: AbortSignal }) {
  const { userId, postId, expectedUpdatedAt } = input;
  const [post] = await db.select().from(posts).where(and(eq(posts.id, postId), eq(posts.userId, userId))).limit(1);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  if (post.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new ApiError(409, "conflict", STALE);
  const guard = await checkAccountGuardrails(userId);
  if (guard.blocked) throw new ApiError(429, "rate_limited", guard.message);

  const settings = await getEffectiveSettings(userId, post.siteId);
  const deps = input.deps ?? await loadDeps(userId, settings.engineSettings);
  const g = ENGINE_CONFIG.gates;
  const prompt = await preparePrompt("revise-comments", {
    dataRule: DATA_RULE,
    voice: buildVoiceContentInstructions(settings as never).join("\n") || "No custom voice rules.",
    styleRules: post.siteId ? await styleRulesText(userId, post.siteId, "draft") : NO_RULES,
    titleMax: g.titleMax,
    descriptionMax: g.descriptionMax,
    comments: fenceData("comments", sanitizeText(input.comments)),
    meta: fenceData("meta", `Title: ${post.title}\nDescription: ${post.summary ?? ""}`),
    draft: fenceData("article", post.content),
    evidence: fenceData("evidence", (await runEvidence(userId, post.siteId, postId)) || "None: this article has no verified evidence list."),
  });

  const started = Date.now();
  const eventId = await startOperationEvent({ userId, siteId: post.siteId, origin: "web", action: "posts.revise_comments", objectType: "post", objectId: postId });
  let costUsd = 0;
  let ok = false;
  try {
    const r = await deps.llm.json({ role: "revise", model: deps.model, system: prompt.system, user: prompt.user, schema: ReplySchema, maxTokens: 12_000, signal: input.signal });
    costUsd = r.costUsd;
    const markdown = cleanGeneratedPostContent(normalizeDraftMarkdown(sanitizeText(r.value.markdown))).trimEnd();
    const result = await updatePostWithRevision({
      userId, postId, expectedUpdatedAt, source: "save",
      changes: { title: cleanPostTitle(sanitizeText(r.value.title)), content: markdown, summary: sanitizeText(r.value.description).trim() },
    });
    ok = true;
    await recordCommentSignal({ userId, siteId: post.siteId, postId, locale: null, comments: input.comments });
    return result;
  } catch (error) {
    costUsd += Number((error as { costUsd?: number })?.costUsd) || 0;
    if (error instanceof PostVersionConflictError) throw new ApiError(409, "conflict", STALE);
    if (error instanceof ApiError) throw error;
    if (error instanceof RateLimitError) throw new ApiError(429, "rate_limited", "The model is rate limited. Try again in a minute.");
    console.error("[revise-comments] model call failed", (error as Error)?.name);
    throw new ApiError(502, "upstream_failure", "The revision failed and nothing was changed. Try again.");
  } finally {
    await finishOperationEvent({ id: eventId, status: ok ? "succeeded" : "failed", durationMs: Date.now() - started, metadata: { cost_usd: costUsd, comments_length: input.comments.length } }).catch(() => {});
    // Zero-cost (subscription or free model) calls are logged too: the daily request limit counts these rows.
    const model = billedModel(deps.model);
    await db.insert(generationLogs).values({
      userId, postId, usageType: "text", modelId: model, provider: model.split("/")[0] ?? null, status: ok ? "success" : "failed", cost: costUsd,
      responseData: { reviseWithComments: true },
    }).catch(() => console.error("[revise-comments] Could not log spend"));
  }
}
