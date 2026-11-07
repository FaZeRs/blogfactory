import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { generationLogs, postShareKits, posts } from "../db/schema.js";
import { engineAiEndpoint, type EngineLlm } from "../engine/adapters/llm.js";
import { parseEngineSettings, resolveRunSettings } from "../engine/modes.js";
import { DATA_RULE, fenceData, preparePrompt } from "../engine/prompts/load.js";
import { RateLimitError } from "../engine/types.js";
import { sanitizeText, truncate } from "../engine/util.js";
import { ApiError } from "../http/error-contract.js";
import { checkAccountGuardrails } from "./account-guardrails.js";
import { getOpenRouterKey } from "./api-keys.js";
import { INTERACTIVE_TIMEOUT_MS, billedModel, resolveEngineModel, userEngineLlm } from "./engine-llm.js";
import { getEffectiveSettings } from "./user-settings.js";
import { buildVoiceContentInstructions } from "./voice-content.js";

export const SHARE_KIT = { threadMin: 3, threadMax: 6, threadChars: 280, quotesMin: 2, quotesMax: 3, teaserChars: 200, articleChars: 40_000 } as const;
export type ShareKitDeps = { llm: EngineLlm; model: string };
export type ShareKit = { linkedin: string; thread: string[]; newsletter: string; quotes: string[]; teaser: string };

// Loose on purpose: lengths are fitted in code, so a long reply never costs a repair call.
const ReplySchema = z.object({
  linkedin: z.string().min(1),
  thread: z.array(z.string()).min(1),
  newsletter: z.string().min(1),
  quotes: z.array(z.string()).default([]),
  teaser: z.string().min(1),
});

const clean = (s: string) => sanitizeText(s).replace(/[ \t]+\n/g, "\n").trim();
const norm = (s: string) => s.toLowerCase().replace(/[*_`[\]()>#]/g, "").replace(/[“”"‘’']/g, "").replace(/\s+/g, " ").trim();

export const contentHash = (post: { title: string; content: string }) => createHash("sha256").update(`${post.title}\n${post.content}`).digest("hex").slice(0, 32);

/** Fits the model's reply to the kit's limits; a pull quote that is not word for word in the article is dropped. */
export function fitShareKit(reply: z.infer<typeof ReplySchema>, article: string): ShareKit {
  const body = norm(article);
  return {
    linkedin: truncate(clean(reply.linkedin), 3000),
    thread: reply.thread.map(clean).filter(Boolean).map((p) => truncate(p, SHARE_KIT.threadChars)).slice(0, SHARE_KIT.threadMax),
    newsletter: truncate(clean(reply.newsletter), 1200),
    quotes: [...new Set(reply.quotes.map(clean))].filter((q) => q.length >= 20 && body.includes(norm(q))).slice(0, SHARE_KIT.quotesMax),
    teaser: truncate(clean(reply.teaser), SHARE_KIT.teaserChars),
  };
}

async function loadDeps(userId: string, engineSettings: unknown): Promise<ShareKitDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(userId));
  if (!endpoint) throw new ApiError(503, "service_unavailable", "Add an OpenRouter key in Integrations to create a share kit.");
  const model = await resolveEngineModel(endpoint, resolveRunSettings("normal", parseEngineSettings(engineSettings)).models.brief);
  return { llm: await userEngineLlm(userId, endpoint, { timeoutMs: INTERACTIVE_TIMEOUT_MS }), model };
}

async function ownedPost(userId: string, postId: string) {
  const [post] = await db.select({ id: posts.id, siteId: posts.siteId, title: posts.title, content: posts.content }).from(posts)
    .where(and(eq(posts.id, postId), eq(posts.userId, userId))).limit(1);
  if (!post) throw new ApiError(404, "not_found", "Post not found");
  return post;
}

/** The stored kit, with `stale` when the post's title or content changed after it was written; null when there is none. */
export async function getShareKit(userId: string, postId: string) {
  const post = await ownedPost(userId, postId);
  const [row] = await db.select().from(postShareKits).where(and(eq(postShareKits.postId, postId), eq(postShareKits.userId, userId))).limit(1);
  return row ? { kit: row.kit as ShareKit, createdAt: row.createdAt.toISOString(), stale: row.contentHash !== contentHash(post) } : null;
}

/** One model call writes the kit from the saved post and replaces any earlier kit. The web ledger middleware records the request. */
export async function createShareKit(input: { userId: string; postId: string; deps?: ShareKitDeps; signal?: AbortSignal }) {
  const { userId, postId } = input;
  const post = await ownedPost(userId, postId);
  if (post.content.trim().length < 200) throw new ApiError(400, "validation_error", "The post is too short to share yet.");
  const guard = await checkAccountGuardrails(userId);
  if (guard.blocked) throw new ApiError(429, "rate_limited", guard.message);

  const settings = await getEffectiveSettings(userId, post.siteId);
  const deps = input.deps ?? await loadDeps(userId, settings.engineSettings);
  const prompt = await preparePrompt("share-kit", {
    dataRule: DATA_RULE,
    voice: buildVoiceContentInstructions(settings as never).join("\n") || "No custom voice rules.",
    threadMin: SHARE_KIT.threadMin,
    threadMax: SHARE_KIT.threadMax,
    threadChars: SHARE_KIT.threadChars,
    quotesMin: SHARE_KIT.quotesMin,
    quotesMax: SHARE_KIT.quotesMax,
    teaserChars: SHARE_KIT.teaserChars,
    title: fenceData("title", post.title),
    article: fenceData("article", truncate(post.content, SHARE_KIT.articleChars)),
  });
  let costUsd = 0;
  let ok = false;
  try {
    const r = await deps.llm.json({ role: "brief", model: deps.model, system: prompt.system, user: prompt.user, schema: ReplySchema, maxTokens: 4000, signal: input.signal });
    costUsd = r.costUsd;
    const kit = fitShareKit(r.value, post.content);
    const row = { kit, contentHash: contentHash(post), modelId: billedModel(deps.model), createdAt: new Date() };
    await db.insert(postShareKits).values({ postId, userId, ...row }).onConflictDoUpdate({ target: postShareKits.postId, set: row });
    ok = true;
    return { kit, createdAt: row.createdAt.toISOString(), stale: false };
  } catch (error) {
    costUsd += Number((error as { costUsd?: number })?.costUsd) || 0;
    if (error instanceof ApiError) throw error;
    if (error instanceof RateLimitError) throw new ApiError(429, "rate_limited", "The model is rate limited. Try again in a minute.");
    console.error("[share-kit] model call failed", (error as Error)?.name, (error as Error)?.message);
    throw new ApiError(502, "upstream_failure", "The share kit could not be written. Try again.");
  } finally {
    if (costUsd > 0) {
      const model = billedModel(deps.model);
      await db.insert(generationLogs).values({
        userId, postId, usageType: "text", modelId: model, provider: model.split("/")[0] ?? null, status: ok ? "success" : "failed", cost: costUsd,
        responseData: { shareKit: true },
      }).catch(() => console.error("[share-kit] Could not log spend"));
    }
  }
}
