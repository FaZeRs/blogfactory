import assert from "node:assert/strict";
import { createPageReader, MAX_PAGE_BYTES, MAX_PAGE_CHARS } from "./reader.js";
import { createFakeReader, createFakeSearch } from "./fakes.js";

const URL1 = "https://example.com/post";
const html = (body: string) => `<html><head><title>My &amp; Title</title></head><body><article>${body}</article></body></html>`;
const htmlRes = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });
const never = (async () => { throw new Error("must not fetch"); }) as never;
const publicHost = async () => [];

// Crawl4AI path, with bearer token.
{
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ markdown: "# Crawled\n\nbody", success: true }));
  }) as unknown as typeof fetch;
  const page = await createPageReader({ CRAWL4AI_URL: "http://crawl:11235/", CRAWL4AI_TOKEN: "tok" }, { fetchImpl, safeFetch: never, resolveHost: publicHost }).read(URL1);
  assert.equal(page.fetchedVia, "crawl4ai");
  assert.equal(page.title, "Crawled");
  assert.equal(seen!.url, "http://crawl:11235/md");
  assert.equal((seen!.init.headers as any).authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { f: "fit", url: URL1 });
}

// Crawl4AI 500 and empty markdown fall back to safe-fetch.
for (const crawl of [new Response("boom", { status: 500 }), new Response(JSON.stringify({ markdown: "  " }))]) {
  const page = await createPageReader(
    { CRAWL4AI_URL: "http://crawl" },
    { fetchImpl: (async () => crawl) as never, safeFetch: (async () => htmlRes(html("Hello world"))) as never, resolveHost: publicHost },
  ).read(URL1);
  assert.equal(page.fetchedVia, "safe-fetch");
  assert.equal(page.status, 200);
  assert.equal(page.title, "My & Title");
  assert.equal(page.markdown, "Hello world");
}

// Review Focus 1: unusable pages return the real status and empty markdown, never throw.
const read = (res: Response | Error) =>
  createPageReader({}, { safeFetch: (async () => { if (res instanceof Error) throw res; return res; }) as never }).read(URL1);
{
  const pdf = await read(new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
  assert.deepEqual([pdf.markdown, pdf.status], ["", 200]);
  const big = await read(htmlRes("x".repeat(5_000_000)));
  assert.deepEqual([big.markdown, big.status], ["", 200]);
  const declared = await read(htmlRes("x", { headers: { "content-length": String(MAX_PAGE_BYTES + 1) } }));
  assert.equal(declared.markdown, "");
  const paywall = await read(htmlRes("subscribe", { status: 401 }));
  assert.deepEqual([paywall.markdown, paywall.status], ["", 401]);
  const failed = await read(new Error("Response is too large"));
  assert.deepEqual([failed.markdown, failed.status], ["", 0]);
  const long = await read(htmlRes(html("word ".repeat(MAX_PAGE_CHARS))));
  assert.ok(long.markdown.length > 0 && long.markdown.length <= MAX_PAGE_CHARS);
}

// SSRF: refused before any fetch.
await assert.rejects(
  createPageReader({ CRAWL4AI_URL: "http://crawl" }, { fetchImpl: never, safeFetch: never }).read("http://192.168.0.1/"),
  /public/,
);

// Crawl4AI never sees a name that resolves to a private address.
await assert.rejects(
  createPageReader({ CRAWL4AI_URL: "http://crawl" }, {
    fetchImpl: never, safeFetch: never,
    resolveHost: async () => { throw new Error("URL host resolves to a non-public address"); },
  }).read(URL1),
  /non-public/,
);

// Fakes
const reader = createFakeReader({ [URL1]: { markdown: "m" } });
assert.equal((await reader.read(URL1)).markdown, "m");
assert.equal((await reader.read("https://x.example/")).status, 404);
assert.equal((await createFakeSearch({ q: [{ url: "u", title: "t", snippet: "s" }] }).search("q", { locale: "en", limit: 5 })).length, 1);

console.log("reader adapter self-check passed");
