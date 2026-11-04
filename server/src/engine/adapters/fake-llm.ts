import type { ModelRole } from "../types.js";
import type { EngineLlm, EngineLlmRequest } from "./llm.js";

/** Replies are keyed by role and consumed in order; each is validated against the request schema. */
export function createFakeLlm(
  replies: Record<string, unknown[]>,
): EngineLlm & { calls: Array<EngineLlmRequest<unknown>> } {
  const queues = new Map(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  const calls: Array<EngineLlmRequest<unknown>> = [];
  return {
    calls,
    async json(req) {
      calls.push(req as EngineLlmRequest<unknown>);
      const queue = queues.get(req.role satisfies ModelRole);
      if (!queue?.length) throw new Error(`fake llm: no reply left for role ${req.role}`);
      const value = req.schema.parse(queue.shift());
      return { value, model: req.model, promptTokens: 0, completionTokens: 0, costUsd: 0 };
    },
  };
}
