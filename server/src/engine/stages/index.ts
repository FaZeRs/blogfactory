import type { Stage } from "../runtime/stage.js";
import type { StageKey } from "../types.js";
import { briefStage } from "./brief/index.js";
import { draftStage } from "./draft/index.js";
import { researchStage } from "./research/index.js";

/**
 * The stage registry handed to `loadEngineDeps(run, STAGES)`. Gates, revise and deliver (the second
 * half of Task 11) add their entries here; until then `STAGES` holds only the stages that exist.
 */
export const STAGES: Partial<Record<StageKey, Stage<any, any>>> = {
  research: researchStage,
  brief: briefStage,
  draft: draftStage,
};
