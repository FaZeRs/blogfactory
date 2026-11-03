import type { DataForSeoClient, SearchHit } from "./types.js";

export type { SearchHit };
export type SearchClient = {
  name: "searxng" | "dataforseo" | "none";
  search(query: string, opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<SearchHit[]>;
};

type Env = Record<string, string | undefined>;

export function createSearchClient(env: Env, dataForSeo: DataForSeoClient | null, fetchImpl: typeof fetch = fetch): SearchClient {
  const base = env.SEARXNG_URL?.trim().replace(/\/+$/, "");
  const viaDataForSeo = (query: string, opts: Parameters<SearchClient["search"]>[1]) =>
    dataForSeo!.serp(query, opts);

  if (!base) {
    return dataForSeo
      ? { name: "dataforseo", search: viaDataForSeo }
      : { name: "none", search: async () => [] };
  }

  return {
    name: "searxng",
    async search(query, opts) {
      try {
        const url = `${base}/search?${new URLSearchParams({ q: query, format: "json", language: opts.locale })}`;
        const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: opts.signal });
        if (!res.ok) throw new Error(`SearXNG ${res.status}`);
        const body = (await res.json()) as { results?: Array<{ url?: unknown; title?: unknown; content?: unknown }> };
        return (body.results ?? [])
          .filter((r) => typeof r.url === "string" && r.url)
          .slice(0, opts.limit)
          .map((r) => ({ url: r.url as string, title: String(r.title ?? ""), snippet: String(r.content ?? "") }));
      } catch (error) {
        if (opts.signal?.aborted || !dataForSeo) throw error;
        return viaDataForSeo(query, opts);
      }
    },
  };
}
