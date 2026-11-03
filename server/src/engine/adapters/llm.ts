import { z } from "zod";
import { RateLimitError, type ModelRole } from "../types.js";

export type EngineLlmRequest<T> = {
  role: ModelRole;
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  signal?: AbortSignal;
};

export type EngineLlmResult<T> = {
  value: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

export type EngineLlm = {
  json<T>(req: EngineLlmRequest<T>): Promise<EngineLlmResult<T>>;
};

export type EngineEndpoint = {
  baseUrl: string;
  apiKey: string;
  gateway: "openrouter" | "custom";
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const COST_HEADER = "x-litellm-response-cost";

/** A custom base URL never borrows the user's OpenRouter key. */
export function engineAiEndpoint(
  env: Record<string, string | undefined>,
  openRouterKey: string | null,
): EngineEndpoint | null {
  const custom = env.ENGINE_AI_BASE_URL?.trim();
  if (custom) {
    const apiKey = env.ENGINE_AI_API_KEY?.trim();
    return apiKey ? { baseUrl: custom.replace(/\/+$/, ""), apiKey, gateway: "custom" } : null;
  }
  return openRouterKey ? { baseUrl: OPENROUTER_URL, apiKey: openRouterKey, gateway: "openrouter" } : null;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```[A-Za-z0-9_-]*\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

function costOf(body: any, headers: Headers): number {
  const fromBody = Number(body?.usage?.cost);
  if (Number.isFinite(fromBody) && fromBody >= 0 && body?.usage?.cost != null) return fromBody;
  const raw = headers.get(COST_HEADER)?.trim();
  const fromHeader = raw ? Number(raw) : NaN;
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : 0;
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createEngineLlm(
  endpoint: EngineEndpoint,
  fetchImpl: typeof fetch = fetch,
): EngineLlm {
  return {
    async json<T>(req: EngineLlmRequest<T>): Promise<EngineLlmResult<T>> {
      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ];
      const jsonSchema = z.toJSONSchema(req.schema);
      let promptTokens = 0;
      let completionTokens = 0;
      let costUsd = 0;
      let model = req.model;
      let failure = "";

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            model: req.model,
            messages,
            max_tokens: req.maxTokens,
            response_format: {
              type: "json_schema",
              json_schema: { name: req.role, schema: jsonSchema, strict: true },
            },
            usage: { include: true },
          }),
          signal: req.signal,
        });
        if (res.status === 429) {
          throw new RateLimitError(`LLM rate limited (${req.role})`, retryAfterMs(res.headers));
        }
        if (!res.ok) {
          // The body is not echoed: it can carry prompt fragments.
          throw new Error(`LLM request failed (${req.role}): HTTP ${res.status}`);
        }
        const body: any = await res.json();
        promptTokens += Number(body?.usage?.prompt_tokens) || 0;
        completionTokens += Number(body?.usage?.completion_tokens) || 0;
        costUsd += costOf(body, res.headers);
        model = typeof body?.model === "string" ? body.model : model;
        const content = body?.choices?.[0]?.message?.content;
        const text = typeof content === "string" ? content : "";

        let parsed: unknown;
        try {
          parsed = parseJson(text);
        } catch {
          failure = "reply was not valid JSON";
          messages.push({ role: "assistant", content: text }, {
            role: "user",
            content: `Your reply was not valid JSON. Reply with only JSON matching the schema.`,
          });
          continue;
        }
        const checked = req.schema.safeParse(parsed);
        if (checked.success) {
          return { value: checked.data, model, promptTokens, completionTokens, costUsd };
        }
        failure = `reply failed the schema: ${JSON.stringify(checked.error.issues)}`;
        messages.push({ role: "assistant", content: text }, {
          role: "user",
          content: `Your reply failed schema validation. Fix these issues and reply with only the corrected JSON:\n${JSON.stringify(checked.error.issues)}`,
        });
      }
      throw new Error(`LLM ${req.role}: ${failure}`);
    },
  };
}
