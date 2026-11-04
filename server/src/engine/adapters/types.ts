export type SearchHit = { url: string; title: string; snippet: string };

export type KeywordOverview = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  aiOverview: boolean;
};

export interface DataForSeoClient {
  serp(query: string, opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<SearchHit[]>;
  keywordOverview(keyword: string, opts: { locale: string; signal?: AbortSignal }): Promise<KeywordOverview | null>;
  /** Related keywords for a few seed topics, with volume, difficulty and intent. Volume 0 or unknown is dropped. */
  keywordIdeas(seeds: string[], opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<KeywordOverview[]>;
  peopleAlsoAsk(query: string, opts: { locale: string }): Promise<string[]>;
}
