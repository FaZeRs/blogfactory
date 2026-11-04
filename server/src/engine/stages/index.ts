import type { Stage } from "../runtime/stage.js";
import type { StageKey } from "../types.js";
import { briefStage } from "./brief/index.js";
import { deliverStage } from "./deliver/index.js";
import { draftStage } from "./draft/index.js";
import { gatesStage } from "./gates/index.js";
import { researchStage } from "./research/index.js";
import { reviseStage } from "./revise/index.js";

/** The stage registry handed to `loadEngineDeps(run, STAGES)`. */
export const STAGES: Record<StageKey, Stage<any, any>> = {
  research: researchStage,
  brief: briefStage,
  draft: draftStage,
  gates: gatesStage,
  revise: reviseStage,
  deliver: deliverStage,
};
