export type SearchHit = { url: string; title: string; snippet: string };

// Task 6 extends this interface with the rest of the DataForSEO client.
export interface DataForSeoClient {
  serp(query: string, opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<SearchHit[]>;
}
