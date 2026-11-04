import type { EngineMode, ModelRole, StageKey } from "./types.js";

export type CitationStyle = "inline" | "references";

export type ModePreset = {
  stages: StageKey[];
  maxRevise: number;
  research: {
    maxQueries: number;
    maxPages: number;
    maxClaimsPerPage: number;
    /** Top organic results read for the outline analysis (the site itself excluded). */
    maxCompetitors: number;
    minVerifiedClaims: 3;
    useKeywordData: boolean;
  };
  models: Record<ModelRole, string>;
  budgetUsd: number;
  /** Rough per-stage model cost, used to refuse a run the budget cannot cover. Gates and delivery call no model. */
  estimateUsd: Record<StageKey, number>;
};

export type EngineSettings = {
  models?: Partial<Record<ModelRole, string>>;
  budgetUsd?: number;
  citationStyle?: CitationStyle;
};

const STAGES: StageKey[] = ["research", "brief", "draft", "gates", "revise", "deliver"];
const MODEL_ROLES: ModelRole[] = ["research_queries", "research_claims", "brief", "draft", "revise"];
const HAIKU = "anthropic/claude-haiku-5.5";

function models(writer: string): Record<ModelRole, string> {
  return { research_queries: HAIKU, research_claims: HAIKU, brief: writer, draft: writer, revise: writer };
}

export const MODE_PRESETS: Record<EngineMode, ModePreset> = {
  normal: {
    stages: STAGES,
    maxRevise: 1,
    research: { maxQueries: 3, maxPages: 6, maxClaimsPerPage: 5, maxCompetitors: 4, minVerifiedClaims: 3, useKeywordData: false },
    models: models("anthropic/claude-sonnet-5.5"),
    budgetUsd: 1,
    estimateUsd: { research: 0.05, brief: 0.03, draft: 0.15, gates: 0, revise: 0.07, deliver: 0 },
  },
  deep: {
    stages: STAGES,
    maxRevise: 2,
    research: { maxQueries: 6, maxPages: 12, maxClaimsPerPage: 6, maxCompetitors: 5, minVerifiedClaims: 3, useKeywordData: true },
    models: models("anthropic/claude-opus-5.5"),
    budgetUsd: 5,
    estimateUsd: { research: 0.3, brief: 0.2, draft: 0.9, gates: 0, revise: 0.6, deliver: 0 },
  },
};

export function parseEngineSettings(value: unknown): EngineSettings {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: EngineSettings = {};

  if (raw.models && typeof raw.models === "object") {
    const picked: Partial<Record<ModelRole, string>> = {};
    for (const role of MODEL_ROLES) {
      const id = (raw.models as Record<string, unknown>)[role];
      if (typeof id === "string" && id.trim()) picked[role] = id.trim();
    }
    if (Object.keys(picked).length) out.models = picked;
  }
  if (typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd > 0) out.budgetUsd = raw.budgetUsd;
  if (raw.citationStyle === "inline" || raw.citationStyle === "references") out.citationStyle = raw.citationStyle;
  return out;
}

export function resolveRunSettings(mode: EngineMode, settings: EngineSettings) {
  const preset = MODE_PRESETS[mode];
  return {
    preset,
    models: { ...preset.models, ...settings.models },
    budgetUsd: settings.budgetUsd ?? preset.budgetUsd,
    citationStyle: settings.citationStyle ?? ("references" as CitationStyle),
  };
}

export function estimateRunUsd(mode: EngineMode): number {
  return Object.values(MODE_PRESETS[mode].estimateUsd).reduce((sum, n) => sum + n, 0);
}
