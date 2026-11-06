import type { EngineConfig } from "../config.js";
import { toPlainText } from "../markdown/plain-text.js";
import { citationsGate } from "./citations.js";
import { componentsGate } from "./components.js";
import { linksGate } from "./links.js";
import { faqGate, metaGate } from "./meta.js";
import { overlapGate } from "./overlap.js";
import { similarityGate } from "./similarity.js";
import { structureGate } from "./structure.js";
import { styleGate } from "./style.js";
import type { GateInput, GateResult } from "./types.js";
import { voiceGate } from "./voice.js";

/**
 * The code gates, in this fixed order: structure, components (Lindevo profile only), meta, faq, voice, voice-warnings, style, style-warnings, citations, links,
 * links-warnings, overlap, similarity.
 */
export async function runCodeGates(
  input: GateInput,
  deps: {
    config: EngineConfig;
    checkLink: (url: string, signal?: AbortSignal) => Promise<number>;
    signal?: AbortSignal;
  }
): Promise<GateResult[]> {
  const cfg = deps.config.gates;
  return [
    structureGate(input.markdown),
    ...(input.components ? [componentsGate(input.markdown, input.components)] : []),
    metaGate(input, cfg),
    faqGate(input.markdown, cfg),
    ...voiceGate(
      `${input.title}\n${input.description}\n${toPlainText(input.markdown)}`,
      deps.config.voice
    ),
    ...styleGate(input.markdown),
    citationsGate(input),
    ...(await linksGate(input, deps)),
    overlapGate(input, cfg),
    similarityGate(input, cfg),
  ];
}
