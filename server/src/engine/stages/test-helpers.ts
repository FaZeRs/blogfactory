import { createFakeLlm } from "../adapters/fake-llm.js";
import { createFakeReader, createFakeSearch } from "../adapters/fakes.js";
import type { DataForSeoClient } from "../adapters/types.js";
import type { ArticleRunRow, StageContext } from "../runtime/stage.js";

export function fakeCtx(
  over: {
    llm?: Record<string, unknown[]>;
    search?: Parameters<typeof createFakeSearch>[0];
    pages?: Parameters<typeof createFakeReader>[0];
    dataForSeo?: DataForSeoClient | null;
    mode?: string;
  } = {},
) {
  const llm = createFakeLlm(over.llm ?? {});
  const run = { id: "r1", userId: "u1", siteId: "s1", mode: over.mode ?? "normal", settings: {}, locale: "en", topic: "t", sourceType: "article_keyword" } as unknown as ArticleRunRow;
  const ctx: StageContext = {
    run,
    attempt: 1,
    signal: new AbortController().signal,
    deps: {
      llm,
      search: createFakeSearch(over.search ?? {}),
      reader: createFakeReader(over.pages ?? {}),
      dataForSeo: over.dataForSeo ?? null,
      now: () => new Date("2026-11-03T00:00:00Z"),
      stages: {} as never,
    },
  };
  return { ctx, llm };
}
