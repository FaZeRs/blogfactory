import { createDataForSeoClient } from "../adapters/dataforseo.js";
import { engineAiEndpoint, type EngineLlm } from "../adapters/llm.js";
import { createPageReader, type PageReader } from "../adapters/reader.js";
import { createSearchClient, type SearchClient } from "../adapters/search.js";
import type { DataForSeoClient } from "../adapters/types.js";
import { StageInputError, type StageKey } from "../types.js";
import { getOpenRouterKey } from "../../services/api-keys.js";
import type { ArticleRunRow, Stage } from "./stage.js";
import { userEngineLlm } from "../../services/engine-llm.js";

export type EngineDeps = {
  llm: EngineLlm;
  search: SearchClient;
  reader: PageReader;
  dataForSeo: DataForSeoClient | null;
  now: () => Date;
  stages: Record<StageKey, Stage<unknown, unknown>>;
};

// shortcut: provider spend is per-process memory, so the monthly cap resets on restart; persist it with the ledger when DataForSEO is enabled for real.
let dataForSeoSpent = { month: "", usd: 0 };
const month = () => new Date().toISOString().slice(0, 7);
export const dataForSeoSpend = {
  monthlySpentUsd: async () => (dataForSeoSpent.month === month() ? dataForSeoSpent.usd : 0),
  recordSpend: async (usd: number) => {
    dataForSeoSpent = { month: month(), usd: (dataForSeoSpent.month === month() ? dataForSeoSpent.usd : 0) + usd };
  },
};

/** The OpenRouter key is read for the run's own user only. Task 11 passes the real stage registry. */
export async function loadEngineDeps(
  run: ArticleRunRow,
  stages: EngineDeps["stages"] = {} as EngineDeps["stages"],
): Promise<EngineDeps> {
  const endpoint = engineAiEndpoint(process.env, await getOpenRouterKey(run.userId));
  if (!endpoint) throw new StageInputError("OpenRouter is not configured");
  const dataForSeo = createDataForSeoClient(process.env, dataForSeoSpend);
  return {
    llm: await userEngineLlm(run.userId, endpoint),
    search: createSearchClient(process.env, dataForSeo),
    reader: createPageReader(process.env),
    dataForSeo,
    now: () => new Date(),
    stages,
  };
}
