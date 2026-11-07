import assert from "node:assert/strict";
import { normalizeIdeaSettings } from "./settings.js";
import { collectSignals, diffLinks, extractLinks, type CollectorDeps } from "./signals.js";

// settings: bounds, invalid entries dropped, seen links kept only for listed pages
const s = normalizeIdeaSettings({ sources: {
  feeds: ["https://a.test/feed", "ftp://a.test/x", "not a url", "https://a.test/feed", ...Array.from({ length: 30 }, (_, i) => `https://f${i}.test/rss`)],
  hn: { queries: ["crm", "", ...Array.from({ length: 20 }, (_, i) => `q${i}`), "x".repeat(200)], minPoints: 5000 },
  subreddits: ["r/webdev", "/r/ab", "a", "bad name", "x".repeat(22), "ok_name"],
  pages: [{ url: "https://p.test/blog", pattern: "/blog/" }, { url: "javascript:alert(1)" }, { url: "https://p.test/blog" }, { url: "https://q.test/", pattern: "y".repeat(200) }],
  seen: { "https://p.test/blog": ["https://p.test/blog/a"], "https://gone.test/": ["https://gone.test/x"] },
} }).sources;
assert.equal(s.feeds.length, 20);
assert.equal(s.feeds[0], "https://a.test/feed");
assert.ok(!s.feeds.some((u) => u.startsWith("ftp")));
assert.equal(s.hn.queries.length, 10);
assert.equal(s.hn.queries.includes("crm"), true);
assert.equal(s.hn.minPoints, 1000);
assert.deepEqual(s.subreddits, ["webdev", "ab", "ok_name"]);
assert.deepEqual(s.pages.map((p) => p.url), ["https://p.test/blog", "https://q.test/"]);
assert.equal(s.pages[1].pattern?.length, 100);
assert.deepEqual(Object.keys(s.seen), ["https://p.test/blog"], "seen links of unlisted pages are dropped");
assert.deepEqual(normalizeIdeaSettings({}).sources, { feeds: [], hn: { queries: [], minPoints: 20 }, subreddits: [], pages: [], seen: {} });
assert.equal(normalizeIdeaSettings({ sources: { hn: { minPoints: "x" } } }).sources.hn.minPoints, 20);

// link extraction: same host, pattern is a plain substring (regex characters are literal), slug and text
const html = `<a href="/blog/one">First <b>post</b></a> <a href='https://www.p.test/blog/two#x'>Second</a>
  <a href="https://other.test/blog/three">Offsite</a> <a href="/about">About</a> <a href="mailto:a@p.test">m</a>
  <a href="/blog/one">Dup</a> <a href="/blog/.*">literal</a> <a href="/blog">self</a> <a href="/blog/unclosed`;
const all = extractLinks(html, "https://p.test/blog");
assert.deepEqual(all.map((l) => l.url), ["https://p.test/blog/one", "https://www.p.test/blog/two", "https://p.test/about", "https://p.test/blog/.*"]);
assert.equal(all[0].text.replace(/\s+/g, " ").trim(), "First post");
assert.deepEqual(extractLinks(html, "https://p.test/blog", "/blog/.*").map((l) => l.url), ["https://p.test/blog/.*"]);
assert.deepEqual(extractLinks(html, "https://p.test/blog", "/BLOG/T").map((l) => l.url), ["https://www.p.test/blog/two"]);
assert.deepEqual(extractLinks(html, "not a url"), []);

// baseline then diff
const links = [{ url: "https://p.test/blog/a", text: "A" }, { url: "https://p.test/blog/b", text: "B" }];
const first = diffLinks(links, undefined);
assert.deepEqual([first.fresh.length, first.baseline], [0, ["https://p.test/blog/a", "https://p.test/blog/b"]]);
const second = diffLinks([...links, { url: "https://p.test/blog/c", text: "C" }], first.baseline);
assert.deepEqual(second.fresh.map((l) => l.url), ["https://p.test/blog/c"]);
assert.equal(diffLinks(Array.from({ length: 400 }, (_, i) => ({ url: `https://p.test/${i}`, text: "t" })), []).baseline.length, 300);

// collectors with fake fetchers
const NOW = new Date("2026-11-07T00:00:00Z");
const dfs = null;
const calls: string[] = [];
const base = (over: Partial<CollectorDeps> = {}): CollectorDeps => ({
  now: () => NOW, locale: "en", seeds: [], competitors: [], search: { name: "fake", search: async () => [] } as never, dataForSeo: dfs,
  fetchText: async () => "", fetchFeed: async () => [], gscQueries: async () => [], feedUrls: async () => [],
  sources: { feeds: [], hn: { queries: [], minPoints: 20 }, subreddits: [], pages: [], seen: {} },
  ...over,
});
const count = (r: Awaited<ReturnType<typeof collectSignals>>, source: string) => r.reports.find((x) => x.source === source);

const hnBody = { hits: [
  { title: "CRM for plumbers", url: "https://hn.test/a", points: 50, num_comments: 7, created_at: "2026-11-05T00:00:00Z", objectID: "1" },
  { title: "Low points", url: "https://hn.test/b", points: 3, num_comments: 0, created_at: "2026-11-05T00:00:00Z", objectID: "2" },
  { title: "Too old", url: "https://hn.test/c", points: 90, num_comments: 0, created_at: "2026-09-01T00:00:00Z", objectID: "3" },
  { title: "Ask HN: scheduling", points: 40, num_comments: 2, created_at: "2026-11-06T00:00:00Z", objectID: "4" },
] };
const redditBody = (names: string[]) => ({ data: { children: [
  ...names.map((title, i) => ({ data: { title, permalink: `/r/x/comments/${i}/t/`, score: 10, num_comments: 2, created_utc: NOW.getTime() / 1000 - 86_400 } })),
  { data: { title: "Pinned", stickied: true, permalink: "/r/x/comments/s/", created_utc: NOW.getTime() / 1000 } },
  { data: { title: "Adult", over_18: true, permalink: "/r/x/comments/n/", created_utc: NOW.getTime() / 1000 } },
  { data: { title: "Old one", permalink: "/r/x/comments/o/", created_utc: NOW.getTime() / 1000 - 40 * 86_400 } },
] } });

const hn = await collectSignals(base({
  sources: { ...base().sources!, hn: { queries: ["crm"], minPoints: 20 } },
  fetchJson: async (url) => { calls.push(url); return { status: 200, body: hnBody }; },
}));
assert.equal(count(hn, "hn")?.count, 2, "minimum points and the 30-day filter apply");
assert.match(hn.signals.find((x) => x.source === "hn")?.summary ?? "", /50 points, 7 comments/);
assert.equal(hn.signals.find((x) => x.title === "Ask HN: scheduling")?.url, "https://news.ycombinator.com/item?id=4");
assert.match(calls[0], /^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date\?query=crm&tags=story&numericFilters=points%3E%3D20%2Ccreated_at_i%3E\d+&hitsPerPage=10$/);
const hnDown = await collectSignals(base({ sources: { ...base().sources!, hn: { queries: ["a", "b"], minPoints: 0 } }, fetchJson: async () => ({ status: 500, body: null }) }));
assert.equal(count(hnDown, "hn")?.error, "HTTP 500", "an error shows when every query failed");

const redditCalls: string[] = [];
const reddit = await collectSignals(base({
  sources: { ...base().sources!, subreddits: ["one", "two", "three"] },
  fetchJson: async (url) => { redditCalls.push(url); return redditCalls.length === 1 ? { status: 200, body: redditBody(["Real post"]) } : { status: 429, body: null }; },
}));
assert.deepEqual(redditCalls.length, 2, "a 429 stops further Reddit calls");
assert.equal(count(reddit, "reddit")?.count, 1);
assert.equal(count(reddit, "reddit")?.error, undefined, "a 429 is not fatal");
assert.equal(reddit.signals.find((x) => x.source === "reddit")?.url, "https://www.reddit.com/r/x/comments/0/t/");
const refused = await collectSignals(base({ sources: { ...base().sources!, subreddits: ["one"] }, fetchJson: async () => ({ status: 403, body: null }) }));
assert.deepEqual([count(refused, "reddit")?.count, count(refused, "reddit")?.error], [0, "Reddit refused (HTTP 403)"], "a refusal with nothing collected is reported");
const badPage = await collectSignals(base({ sources: { ...base().sources!, pages: [{ url: "https://p.test/blog" }] }, fetchText: async () => { throw new Error("Response is too large"); } }));
assert.equal(count(badPage, "page")?.error, "p.test: Response is too large", "every watched page failing is reported");

const feed = await collectSignals(base({
  sources: { ...base().sources!, feeds: ["https://a.test/feed", "https://b.test/feed"] },
  fetchFeed: async (url) => { if (url.includes("b.test")) throw new Error("boom"); return Array.from({ length: 12 }, (_, i) => ({ title: `Feed story number ${i}`, url: `https://a.test/${i}` })); },
}));
assert.equal(count(feed, "feed")?.count, 8, "at most 8 items per feed; a failing feed is skipped");
const feedDown = await collectSignals(base({ sources: { ...base().sources!, feeds: ["https://a.test/feed"] }, fetchFeed: async () => { throw new Error("boom"); } }));
assert.equal(count(feedDown, "feed")?.error, "a.test: boom", "every idea feed failing is reported");

// pages: first run records a baseline only, the second emits the new link; a failing page does not stop the others
const seen: Record<string, string[]> = {};
const pageHtml = (slugs: string[]) => slugs.map((x) => `<a href="/blog/${x}">${x === "c" ? "" : `Post ${x}`}</a>`).join("") + `<a href="/other">Other</a>`;
const pages = [{ url: "https://p.test/blog", pattern: "/blog/" }, { url: "https://bad.test/" }];
const run = (slugs: string[], known: Record<string, string[]>) => collectSignals(base({
  sources: { ...base().sources!, pages, seen: known },
  fetchText: async (url) => { if (url.includes("bad.test")) throw new Error("down"); return pageHtml(slugs); },
  recordSeen: (u, l) => { seen[u] = l; },
}));
const r1 = await run(["a", "b"], {});
assert.equal(count(r1, "page")?.count, 0, "the first run is a baseline");
assert.deepEqual(seen["https://p.test/blog"], ["https://p.test/blog/a", "https://p.test/blog/b"]);
assert.equal(seen["https://bad.test/"], undefined);
const r2 = await run(["a", "b", "c"], { ...seen });
assert.equal(count(r2, "page")?.count, 1);
assert.equal(r2.signals.find((x) => x.source === "page")?.title, "c", "the slug is the title when the link has no text");
assert.equal(r2.signals.find((x) => x.source === "page")?.url, "https://p.test/blog/c");
// a timed-out page read records no baseline, so its new links are not lost
const lateSeen: Record<string, string[]> = {};
const slow = await collectSignals(base({
  sources: { ...base().sources!, pages: [{ url: "https://p.test/blog" }, { url: "https://slow.test/" }], seen: {} },
  fetchText: async (url) => { if (url.includes("slow")) await new Promise((r) => setTimeout(r, 50)); return pageHtml(["a"]); },
  recordSeen: (u, l) => { lateSeen[u] = l; },
}), 10);
assert.equal(count(slow, "page")?.error, "timed out");
await new Promise((r) => setTimeout(r, 80));
assert.deepEqual(lateSeen, {}, "no baseline is recorded after a timeout");
console.log("idea sources self-test passed");
