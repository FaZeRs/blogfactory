import type { articleRuns } from "../../db/schema.js";
import type { StageKey, Transition } from "../types.js";
import type { EngineDeps } from "./deps.js";

export type ArticleRunRow = typeof articleRuns.$inferSelect;

export type StageContext = { run: ArticleRunRow; deps: EngineDeps; signal: AbortSignal; attempt: number };

export type StageOutcome<O> = {
  output: O;
  next: Transition;
  usage?: { model: string; promptTokens: number; completionTokens: number; costUsd: number }[];
};

export type Stage<I, O> = {
  key: StageKey;
  promptVersion: string;
  input(ctx: StageContext): Promise<I>;
  run(input: I, ctx: StageContext): Promise<StageOutcome<O>>;
};
