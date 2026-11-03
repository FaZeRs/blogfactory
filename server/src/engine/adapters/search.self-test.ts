import assert from "node:assert/strict";
import { createSearchClient } from "./search.js";
import type { DataForSeoClient } from "./types.js";

const opts = { locale: "en", limit: 2 };
const dfs = (): DataForSeoClient & { calls: number } => ({
  calls: 0,
  async serp() { this.calls += 1; return [{ url: "https://d.example/", title: "D", snippet: "" }]; },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

{
  let requested = "";
  const f = (async (u: string) => {
    requested = u;
    return json({ results: [{ url: "https://a.example/", title: "A", content: "sa" }, { title: "no url" }, { url: "https://b.example/" }, { url: "https://c.example/" }] });
  }) as unknown as typeof fetch;
  const d = dfs();
  const c = createSearchClient({ SEARXNG_URL: "http://searx:8080/" }, d, f);
  assert.equal(c.name, "searxng");
  const hits = await c.search("q x", opts);
  assert.deepEqual(hits, [{ url: "https://a.example/", title: "A", snippet: "sa" }, { url: "https://b.example/", title: "", snippet: "" }]);
  assert.equal(requested, "http://searx:8080/search?q=q+x&format=json&language=en");
  assert.equal(d.calls, 0);
}
for (const failing of [
  (async () => { throw new Error("down"); }) as unknown as typeof fetch,
  (async () => json({}, 500)) as unknown as typeof fetch,
]) {
  const d = dfs();
  const hits = await createSearchClient({ SEARXNG_URL: "http://searx" }, d, failing).search("q", opts);
  assert.equal(d.calls, 1);
  assert.equal(hits[0].url, "https://d.example/");
}
{
  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  await assert.rejects(createSearchClient({ SEARXNG_URL: "http://searx" }, null, failing).search("q", opts), /down/);
}
{
  assert.equal(createSearchClient({}, dfs()).name, "dataforseo");
  const none = createSearchClient({}, null);
  assert.equal(none.name, "none");
  assert.deepEqual(await none.search("q", opts), []);
}
console.log("search adapter self-check passed");
