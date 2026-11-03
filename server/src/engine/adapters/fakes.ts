import type { PageReader, ReadPage } from "./reader.js";
import type { SearchClient } from "./search.js";
import type { SearchHit } from "./types.js";

export function createFakeSearch(hits: Record<string, SearchHit[]>): SearchClient {
  return { name: "searxng", search: async (query, opts) => (hits[query] ?? []).slice(0, opts.limit) };
}

export function createFakeReader(pages: Record<string, Partial<ReadPage>>): PageReader {
  return {
    async read(url) {
      const page = pages[url];
      return {
        url, finalUrl: url, status: page ? 200 : 404, title: null, markdown: "",
        fetchedVia: "safe-fetch", fetchedAt: new Date(0), ...page,
      };
    },
  };
}
