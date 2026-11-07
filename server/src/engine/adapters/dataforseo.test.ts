import { expect, test } from "bun:test";
import { RateLimitError } from "../types.js";
import { createDataForSeoClient, localeMarket } from "./dataforseo.js";

const ENV = { DATAFORSEO_LOGIN: "api@example.com", DATAFORSEO_PASSWORD: "hunter2hunter2" };
const ok = (result: unknown[], cost: unknown = 0.0103) => ({
  cost,
  status_code: 20_000,
  tasks: [{ cost, result, status_code: 20_000 }],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, env: Record<string, string | undefined> = ENV, spentBefore = 0) {
  const spend: number[] = [];
  const calls: Array<{ url: string; body: any; auth: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body))[0], auth: (init.headers as Record<string, string>).Authorization });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const client = createDataForSeoClient(env, {
    fetchImpl,
    monthlySpentUsd: async () => spentBefore,
    recordSpend: async (usd) => void spend.push(usd),
  });
  return { client: client!, calls, spend };
}

const serpBody = ok([
  {
    items: [
      { type: "organic", title: "A", description: "a", url: "https://a.example/x" },
      { type: "organic", title: "Bad", url: "javascript:alert(1)" },
      { type: "people_also_ask", items: [{ title: "Why?" }, { title: "" }, { nope: 1 }] },
      { type: "organic", title: "B", description: "b", url: "https://b.example/" },
    ],
  },
]);

test("localeMarket maps known locales and falls back to en", () => {
  expect(localeMarket("en")).toEqual({ locationCode: 2840, languageCode: "en" });
  expect(localeMarket("lv")).toEqual({ locationCode: 2428, languageCode: "lv" });
  expect(localeMarket("tr")).toEqual({ locationCode: 2792, languageCode: "tr" });
  expect(localeMarket("de")).toEqual({ locationCode: 2840, languageCode: "en" });
});

test("no client without credentials", () => {
  const deps = { monthlySpentUsd: async () => 0, recordSpend: async () => {} };
  expect(createDataForSeoClient({}, deps)).toBeNull();
  expect(createDataForSeoClient({ DATAFORSEO_LOGIN: "x" }, deps)).toBeNull();
});

test("serp keeps http(s) organic hits, sends the market and Basic auth, books the cost", async () => {
  const { client, calls, spend } = setup(() => json(serpBody));
  const hits = await client.serp("coffee", { locale: "lv", limit: 1 });
  expect(hits).toEqual([{ url: "https://a.example/x", title: "A", snippet: "a" }]);
  expect(calls[0].body).toMatchObject({ keyword: "coffee", location_code: 2428, language_code: "lv", depth: 1 });
  expect(calls[0].auth).toBe(`Basic ${Buffer.from("api@example.com:hunter2hunter2").toString("base64")}`);
  expect(spend).toEqual([0.0103]);
});

test("peopleAlsoAsk returns clean questions", async () => {
  const { client } = setup(() => json(serpBody));
  expect(await client.peopleAlsoAsk("coffee", { locale: "en" })).toEqual(["Why?"]);
});

test("keywordOverview maps volume, difficulty, intent and AI overview", async () => {
  const { client, calls } = setup(() =>
    json(
      ok([
        {
          items: [
            {
              keyword: "coffee",
              keyword_info: { search_volume: 1900 },
              keyword_properties: { keyword_difficulty: "bad" },
              search_intent_info: { main_intent: "informational" },
              serp_info: { serp_item_types: ["organic", "ai_overview"] },
            },
          ],
        },
      ]),
    ),
  );
  expect(await client.keywordOverview("coffee", { locale: "en" })).toEqual({
    keyword: "coffee", volume: 1900, difficulty: null, intent: "informational", aiOverview: true,
  });
  expect(calls[0].body.keywords).toEqual(["coffee"]);
});

test("keywordOverview returns null for an empty result (40102)", async () => {
  const { client } = setup(() => json({ status_code: 20_000, cost: 0.01, tasks: [{ status_code: 40_102, result: null }] }));
  expect(await client.keywordOverview("zzz", { locale: "en" })).toBeNull();
});

test("at the monthly budget calls return empty and never hit the network", async () => {
  const { client, calls } = setup(() => json(serpBody), { ...ENV, DATAFORSEO_MONTHLY_USD: "10" }, 10);
  expect(await client.keywordOverview("coffee", { locale: "en" })).toBeNull();
  expect(await client.serp("coffee", { locale: "en", limit: 5 })).toEqual([]);
  expect(await client.peopleAlsoAsk("coffee", { locale: "en" })).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("the default budget is 10 USD", async () => {
  const { client, calls } = setup(() => json(serpBody), ENV, 10);
  expect(await client.serp("x", { locale: "en", limit: 5 })).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("a missing cost books the estimate; a refused call books nothing", async () => {
  const noCost = setup(() => json({ status_code: 20_000, tasks: [{ status_code: 20_000, result: [] }] }));
  await noCost.client.serp("x", { locale: "en", limit: 5 });
  expect(noCost.spend).toEqual([0.002]);
  const refused = setup(() => json({ status_code: 40_501, status_message: "bad field" }));
  await expect(refused.client.serp("x", { locale: "en", limit: 5 })).rejects.toThrow("40501");
  expect(refused.spend).toEqual([]);
});

test("a refused task that was billed still books its cost", async () => {
  const { client, spend } = setup(() => json({ status_code: 40_501, cost: 0.5, status_message: "bad" }));
  await expect(client.serp("x", { locale: "en", limit: 5 })).rejects.toThrow();
  expect(spend).toEqual([0.5]);
});

test("quota and rate-limit answers are RateLimitError; others are plain errors", async () => {
  for (const res of [() => new Response("", { status: 429 }), () => json({ status_code: 40_202, status_message: "slow" }), () => new Response("", { status: 402 })]) {
    await expect(setup(res).client.serp("x", { locale: "en", limit: 5 })).rejects.toBeInstanceOf(RateLimitError);
  }
  const err = await setup(() => new Response("", { status: 401 })).client.serp("x", { locale: "en", limit: 5 }).catch((e) => e);
  expect(err).not.toBeInstanceOf(RateLimitError);
});

test("error text never carries the credentials", async () => {
  const body = `bad login api@example.com / hunter2hunter2 / ${Buffer.from("api@example.com:hunter2hunter2").toString("base64")}`;
  const err = await setup(() => new Response(body, { status: 500 })).client.serp("x", { locale: "en", limit: 5 }).catch((e) => e);
  expect(String(err.message)).not.toContain("hunter2");
  expect(String(err.message)).not.toContain("api@example.com");
});

test("an unreadable reply and an oversized one are errors, not crashes", async () => {
  await expect(setup(() => new Response("<html>", { status: 200 })).client.serp("x", { locale: "en", limit: 5 })).rejects.toThrow("59991");
});

test("a pre-aborted signal never reaches the network", async () => {
  const { client, calls } = setup(() => json(serpBody));
  const ac = new AbortController();
  ac.abort();
  await expect(client.serp("x", { locale: "en", limit: 5, signal: ac.signal })).rejects.toBeDefined();
  expect(calls).toHaveLength(0);
});

test("a stalled request times out through the abort signal", async () => {
  const fetchImpl = ((_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  const client = createDataForSeoClient(ENV, { fetchImpl, monthlySpentUsd: async () => 0, recordSpend: async () => {} })!;
  const ac = new AbortController();
  const p = client.serp("x", { locale: "en", limit: 5, signal: ac.signal });
  ac.abort(new Error("stop"));
  await expect(p).rejects.toThrow("stop");
});

test("relatedKeywords reads keyword_data and drops zero volume", async () => {
  const item = (keyword: string, volume: number) => ({ keyword_data: { keyword, keyword_info: { search_volume: volume } }, depth: 1 });
  const { client, calls } = setup(() => json(ok([{ items: [item("n8n cloud pricing", 300), item("n8n docker", 0), { keyword_data: "junk" }] }])));
  const out = await client.relatedKeywords("n8n cloud", { locale: "en", limit: 30 });
  expect(out.map((k) => k.keyword)).toEqual(["n8n cloud pricing"]);
  expect(calls[0].url).toContain("related_keywords/live");
  expect(calls[0].body).toMatchObject({ keyword: "n8n cloud", depth: 1, limit: 30 });
});

test("keywordIdeas drops zero volume, books spend and respects the cap", async () => {
  const item = (keyword: string, volume: number | null) => ({ keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 20 } });
  const { client, calls, spend } = setup(() => json(ok([{ items: [item("a b", 100), item("c d", 0), item("e f", null)] }])));
  const out = await client.keywordIdeas(["a"], { locale: "en", limit: 50 });
  expect(out.map((k) => k.keyword)).toEqual(["a b"]);
  expect(calls[0].url).toContain("keyword_ideas/live");
  expect(calls[0].body.limit).toBe(50);
  expect(spend).toEqual([0.0103]);
  const capped = setup(() => json(ok([])), ENV, 99);
  expect(await capped.client.keywordIdeas(["a"], { locale: "en", limit: 5 })).toEqual([]);
  expect(capped.calls).toHaveLength(0);
});
