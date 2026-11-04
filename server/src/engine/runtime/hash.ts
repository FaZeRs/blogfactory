import { createHash } from "node:crypto";
import type { ModelRole, StageKey } from "../types.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function stageInputHash(stage: StageKey, promptVersion: string, models: Record<ModelRole, string>, input: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable({ stage, promptVersion, models, input }))).digest("hex");
}
