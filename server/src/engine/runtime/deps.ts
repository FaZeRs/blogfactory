import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { providerSpend } from "../../db/schema.js";
import { createDataForSeoClient, type DataForSeoSpend } from "../adapters/dataforseo.js";
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

const month = () => new Date().toISOString().slice(0, 7);
/** DataForSEO spend in Postgres, shared by every process; a reservation only lands while the month stays within the cap. */
export const dataForSeoSpend: DataForSeoSpend = {
  async reserve(usd, capUsd) {
    if (usd > capUsd) return false;
    const rows = await db.insert(providerSpend).values({ provider: "dataforseo", month: month(), usd })
      .onConflictDoUpdate({
        target: [providerSpend.provider, providerSpend.month],
        set: { usd: sql`${providerSpend.usd} + excluded.usd` },
        setWhere: sql`${providerSpend.usd} + excluded.usd <= ${capUsd}`,
      })
      .returning({ usd: providerSpend.usd });
    return rows.length > 0;
  },
  async settle(reservedUsd, usd) {
    if (usd === reservedUsd) return;
    await db.update(providerSpend).set({ usd: sql`GREATEST(0, ${providerSpend.usd} + ${usd - reservedUsd})` })
      .where(and(eq(providerSpend.provider, "dataforseo"), eq(providerSpend.month, month())));
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
