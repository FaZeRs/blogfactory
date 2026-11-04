import { z } from "zod";
import { RateLimitError } from "../types.js";
import { sanitizeText, truncate } from "../util.js";
import type { DataForSeoClient, KeywordOverview, SearchHit } from "./types.js";

export type { DataForSeoClient, KeywordOverview };

const BASE_URL = "https://api.dataforseo.com/v3";
const TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_URL_CHARS = 2048;
const STATUS_OK = 20_000;
/** A task that ran but found nothing: billed, and an empty result rather than an error. */
const STATUS_NO_RESULTS = 40_102;
/** Partial results with a result: paid for, so used. */
const STATUS_PARTIAL = 40_106;
/** Balance and rate-limit codes: the run reschedules instead of burning an attempt. */
const QUOTA_CODES = new Set([40_200, 40_202, 40_210]);
const DEFAULT_MONTHLY_USD = 10;
/** Booked when a billed reply carries no usable cost. */
const ESTIMATE_USD = { serp: 0.002, overview: 0.01 } as const;
const SERP_PATH = "serp/google/organic/live/advanced";
const OVERVIEW_PATH = "dataforseo_labs/google/keyword_overview/live";

type Env = Record<string, string | undefined>;
type Deps = {
  fetchImpl?: typeof fetch;
  monthlySpentUsd: () => Promise<number>;
  recordSpend: (usd: number) => Promise<void>;
};

export function localeMarket(locale: string): { locationCode: number; languageCode: string } {
  switch (locale) {
    case "lv": return { locationCode: 2428, languageCode: "lv" };
    case "tr": return { locationCode: 2792, languageCode: "tr" };
    default: return { locationCode: 2840, languageCode: "en" };
  }
}

const optionalNumber = z.number().nullish().catch(null);
const Envelope = z.object({
  cost: z.unknown().optional(),
  status_code: z.number(),
  status_message: z.string().nullish(),
  tasks: z
    .array(
      z.object({
        cost: z.unknown().optional(),
        result: z.array(z.unknown()).nullish(),
        status_code: z.number(),
        status_message: z.string().nullish(),
      }),
    )
    .nullish(),
});
type Envelope = z.infer<typeof Envelope>;
const SerpResult = z.object({ items: z.array(z.unknown()).nullish() });
const SerpItem = z.object({
  type: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string().nullish(),
  items: z.array(z.unknown()).nullish(),
});
const PaaItem = z.object({ title: z.string().min(1) });
const OverviewResult = z.object({ items: z.array(z.unknown()).nullish() });
const OverviewItem = z.object({
  keyword: z.string(),
  keyword_info: z.object({ search_volume: optionalNumber }).nullish().catch(null),
  keyword_properties: z.object({ keyword_difficulty: optionalNumber }).nullish().catch(null),
  search_intent_info: z.object({ main_intent: z.string().nullish().catch(null) }).nullish().catch(null),
  serp_info: z.object({ serp_item_types: z.array(z.string()).nullish().catch(null) }).nullish().catch(null),
});

/** Items that fit `schema`; one that does not is dropped, never fatal. */
function parseItems<T>(items: readonly unknown[] | null | undefined, schema: z.ZodType<T>): T[] {
  return (items ?? []).flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

const parseCost = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;

function isHttpUrl(url: string): boolean {
  return url.length <= MAX_URL_CHARS && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);
}

const clean = (text: string | null | undefined, max: number) => truncate(sanitizeText(text ?? ""), max);

/** Reads at most `max` bytes; `truncated` when the body was longer. */
async function readBounded(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

export function createDataForSeoClient(env: Env, deps: Deps): DataForSeoClient | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) return null;

  const doFetch = deps.fetchImpl ?? fetch;
  const basic = Buffer.from(`${login}:${password}`).toString("base64");
  const capParsed = Number(env.DATAFORSEO_MONTHLY_USD);
  const cap = env.DATAFORSEO_MONTHLY_USD?.trim() && Number.isFinite(capParsed) ? capParsed : DEFAULT_MONTHLY_USD;

  /** Error text from the provider with the credentials removed by value. */
  const redact = (text: string) =>
    [login, password, basic].reduce((acc, s) => (s.length >= 3 ? acc.replaceAll(s, "[redacted]") : acc), text).slice(0, 300);

  const fail = (path: string, code: number, message: string | null | undefined) => {
    const text = `DataForSEO ${path}: ${code} ${redact(message ?? "")}`.trim();
    return QUOTA_CODES.has(code) || code === 429 || code === 402 ? new RateLimitError(text) : new Error(text);
  };

  const overBudget = async () => (await deps.monthlySpentUsd()) >= cap;

  /** The reply's cost, else its tasks' costs, else 0 for a refused call, else the estimate. */
  function costOf(envelope: Envelope | null, estimate: number): number {
    const reported = parseCost(envelope?.cost);
    if (reported !== null) return reported;
    const tasks = envelope?.tasks ?? [];
    const costs = tasks.map((t) => parseCost(t.cost));
    if (tasks.length > 0 && costs.every((c) => c !== null)) return costs.reduce<number>((a, c) => a + (c ?? 0), 0);
    if (envelope && envelope.cost === undefined && envelope.status_code !== STATUS_OK) return 0;
    return estimate;
  }

  async function call(path: string, body: Record<string, unknown>, estimate: number, signal?: AbortSignal): Promise<unknown[]> {
    signal?.throwIfAborted();
    const deadline = signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]) : AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}/${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
        body: JSON.stringify([body]),
        signal: deadline,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`DataForSEO ${path}: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 402 || res.status === 429) {
        await res.body?.cancel();
        throw fail(path, res.status, res.status === 401 ? "unauthorized: check the API login and password" : "payment required or rate limited");
      }
      const { text } = await readBounded(res, MAX_ERROR_BYTES).catch(() => ({ text: "" }));
      throw fail(path, res.status, text);
    }

    let envelope: Envelope | null = null;
    try {
      const { text, truncated } = await readBounded(res, MAX_REPLY_BYTES);
      const parsed = truncated ? null : Envelope.safeParse(JSON.parse(text));
      envelope = parsed?.success ? parsed.data : null;
    } catch {
      if (signal?.aborted) throw signal.reason;
    }
    // A refused task can still be billed, so the spend is booked before the status is checked.
    const usd = costOf(envelope, estimate);
    if (usd > 0) await deps.recordSpend(usd);
    if (!envelope) throw fail(path, 59_991, "the reply was cut short or is not a DataForSEO response");
    if (envelope.status_code !== STATUS_OK) throw fail(path, envelope.status_code, envelope.status_message);
    const task = envelope.tasks?.[0];
    if (!task) throw fail(path, 59_990, "the response had no task");
    if (task.status_code === STATUS_NO_RESULTS) return [];
    if (task.status_code === STATUS_PARTIAL && task.result?.length) return task.result;
    if (task.status_code !== STATUS_OK) throw fail(path, task.status_code, task.status_message);
    return task.result ?? [];
  }

  const serpElements = async (query: string, locale: string, depth: number, signal?: AbortSignal) => {
    const { locationCode, languageCode } = localeMarket(locale);
    const result = await call(
      SERP_PATH,
      { keyword: query, location_code: locationCode, language_code: languageCode, depth },
      ESTIMATE_USD.serp,
      signal,
    );
    return parseItems(result, SerpResult).flatMap((r) => parseItems(r.items, SerpItem));
  };

  return {
    async serp(query, opts) {
      if (await overBudget()) return [];
      const hits: SearchHit[] = [];
      for (const e of await serpElements(query, opts.locale, Math.max(1, Math.min(opts.limit, 200)), opts.signal)) {
        const url = sanitizeText(e.url ?? "");
        if (e.type === "organic" && isHttpUrl(url)) {
          hits.push({ url, title: clean(e.title, 300), snippet: clean(e.description, 1000) });
        }
      }
      return hits.slice(0, opts.limit);
    },

    async keywordOverview(keyword, opts) {
      if (await overBudget()) return null;
      const { locationCode, languageCode } = localeMarket(opts.locale);
      const result = await call(
        OVERVIEW_PATH,
        { keywords: [keyword], location_code: locationCode, language_code: languageCode },
        ESTIMATE_USD.overview,
        opts.signal,
      );
      const item = parseItems(result, OverviewResult).flatMap((r) => parseItems(r.items, OverviewItem))[0];
      if (!item) return null;
      return {
        keyword: sanitizeText(item.keyword),
        volume: item.keyword_info?.search_volume ?? null,
        difficulty: item.keyword_properties?.keyword_difficulty ?? null,
        intent: item.search_intent_info?.main_intent ?? null,
        aiOverview: item.serp_info?.serp_item_types?.includes("ai_overview") ?? false,
      };
    },

    async peopleAlsoAsk(query, opts) {
      if (await overBudget()) return [];
      const elements = await serpElements(query, opts.locale, 10);
      return elements
        .filter((e) => e.type === "people_also_ask")
        .flatMap((e) => parseItems(e.items, PaaItem).map((q) => clean(q.title, 300).trim()))
        .filter(Boolean);
    },
  };
}
