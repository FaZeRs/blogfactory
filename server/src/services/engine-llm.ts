import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { createEngineLlm, type EngineEndpoint, type EngineLlm } from "../engine/adapters/llm.js";
import { parseModelId, subscriptionsFor, withSubscriptions } from "../engine/adapters/subscription.js";
import { resolveOpenRouterTextModel } from "./openrouter-models.js";

/** The subscription providers this instance enables for the user (`ENGINE_SUBSCRIPTIONS`, `ENGINE_SUBSCRIPTION_USERS`). */
export async function userSubscriptions(userId: string, env: Record<string, string | undefined> = process.env) {
  if (!env.ENGINE_SUBSCRIPTIONS?.trim()) return [];
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return subscriptionsFor(env, user?.email);
}

/** The engine's LLM client for one user: OpenRouter or the instance gateway, plus their allowed subscription CLIs. */
/** Subscription calls made inside a web request: a person is waiting, so they stop well before the engine's 10 minutes. */
export const INTERACTIVE_TIMEOUT_MS = 3 * 60_000;

export async function userEngineLlm(userId: string, endpoint: EngineEndpoint, opts: { timeoutMs?: number } = {}): Promise<EngineLlm> {
  return withSubscriptions(createEngineLlm(endpoint), { env: process.env, allowed: await userSubscriptions(userId), timeoutMs: opts.timeoutMs });
}

/** The model a logged cost belongs to: a subscription call costs $0, so any spend on a subscription id is its fallback's. */
export function billedModel(id: string): string {
  const parsed = parseModelId(id);
  return parsed.provider ? parsed.fallback ?? id : parsed.model;
}

/** Resolves an OpenRouter model id; a subscription id keeps its CLI model and has only its fallback resolved. */
export async function resolveEngineModel(endpoint: EngineEndpoint, id: string): Promise<string> {
  if (endpoint.gateway !== "openrouter") return id;
  const parsed = parseModelId(id);
  if (!parsed.provider) return resolveOpenRouterTextModel(endpoint.apiKey, id);
  // The fallback is a backup: an OpenRouter outage or a delisted model must not block the subscription itself.
  const fallback = parsed.fallback ? await resolveOpenRouterTextModel(endpoint.apiKey, parsed.fallback).catch(() => parsed.fallback) : null;
  return `${parsed.provider}:${parsed.model}${fallback ? `|${fallback}` : ""}`;
}
