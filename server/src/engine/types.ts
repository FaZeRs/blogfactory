export type EngineMode = "normal" | "deep";
export type GenerationMode = "fast" | EngineMode;

export type StageKey =
  | "research"
  | "brief"
  | "draft"
  | "gates"
  | "revise"
  | "deliver";

export type ModelRole =
  | "research_queries"
  | "research_claims"
  | "brief"
  | "draft"
  | "revise";

export type Transition =
  | { type: "advance"; to: StageKey }
  | { type: "done" }
  | { type: "escalate"; reason: string }
  | { type: "wait"; to: StageKey; at: Date };

/** A 429 or quota answer: the run reschedules without using an attempt. */
export class RateLimitError extends Error {
  retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Bad or missing stage input: retrying cannot help, so the stage fails at once. */
export class StageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageInputError";
  }
}
