import assert from "node:assert/strict";
import { createFakeLlm } from "../../engine/adapters/fake-llm.js";
import { createFakeSearch } from "../../engine/adapters/fakes.js";
import type { DataForSeoClient } from "../../engine/adapters/types.js";
import { safeOperationMetadata } from "../operation-events.js";
import { generateCandidates, parseCandidates } from "./candidates.js";
import { fetchKeywordMetrics, scoreCandidates } from "./discovery.js";
import { assessNovelty, similarity } from "./novelty.js";
import { combineScore, demandFactor, feasibilityFactor, trendFactor } from "./score.js";
import { DEFAULT_IDEA_SETTINGS, DEFAULT_WEIGHTS, effectiveSeedTopics, normalizeIdeaSettings } from "./settings.js";
import { collectSignals, mergeSignals, parseSitemap, type CollectorDeps } from "./signals.js";

// novelty
assert.equal(similarity("Best CRM tools for startups", "best crm tool for startups"), 1);
assert.ok(similarity("How to pick a CRM", "Garden tomato guide") < 0.1);
assert.ok(similarity("crm for startups guide", "crm for startups checklist") >= 0.5);
assert.equal(similarity("", "x y"), 0);
const posts = [{ id: "p1", title: "Best CRM tools for startups" }, { id: "p2", title: "Remote work habits" }];
assert.equal(assessNovelty({ title: "Best CRM tool for startups" }, posts).decision, "reject");
const refresh = assessNovelty({ title: "CRM tools for startups compared" }, posts);
assert.equal(refresh.decision, "refresh");
assert.equal(refresh.nearest?.id, "p1");
const fresh = assessNovelty({ title: "Kubernetes cost control" }, posts);
assert.deepEqual([fresh.decision, fresh.novelty], ["ok", 1]);
assert.equal(assessNovelty({ title: "x" }, []).novelty, 1);

// score
const ones = { trend: 1, fit: 1, demand: 1, feasibility: 1, novelty: 1, gain: 1 };
assert.equal(combineScore(ones, DEFAULT_WEIGHTS), 100);
assert.equal(combineScore({ ...ones, demand: 0 }, DEFAULT_WEIGHTS), 0, "one zero factor sinks the score");
assert.equal(combineScore({ ...ones, demand: 0 }, { ...DEFAULT_WEIGHTS, demand: 0 }), 100, "weight 0 ignores a factor");
assert.equal(combineScore({ ...ones, fit: 0.25 }, { ...DEFAULT_WEIGHTS }), Math.round(1000 * Math.exp(Math.log(0.25) / 6)) / 10);
assert.equal(trendFactor({ signalCount: 0, distinctSources: 0, avgAgeDays: 99 }), 0.15);
assert.equal(trendFactor({ signalCount: 8, distinctSources: 4, avgAgeDays: 0 }), 1);
assert.equal(feasibilityFactor(null), 0.6);
assert.equal(feasibilityFactor(100), 0.15);
assert.equal(feasibilityFactor(30), 0.7);
assert.equal(demandFactor({ volume: null, estimate: 5, trend: 0.1 }), 0.5, "no data: the estimate alone");
assert.equal(demandFactor({ volume: 0, estimate: 10, trend: 0.3 }), 0.2, "volume 0 caps demand");
assert.ok(demandFactor({ volume: 0, estimate: 10, trend: 0.7 }) > 0.2, "unless the topic is trending");
assert.ok(Math.abs(demandFactor({ volume: 9999, estimate: 10, trend: 0 }) - 1) < 0.001);

// settings
assert.deepEqual(normalizeIdeaSettings(null), DEFAULT_IDEA_SETTINGS);
const custom = normalizeIdeaSettings({
  cadence: { weekdays: [5, 5, 9, 1], time: "25:00", timezone: "Mars/Base" }, leadDays: 99, defaultMode: "deep",
  autopilot: { enabled: true, approvePerWeek: 0, minScore: 70 }, weights: { fit: 3, trend: -1, bogus: 4 },
  seedTopics: [" a ", "a", 5], competitors: ["x.com"],
});
assert.deepEqual(custom.cadence, { weekdays: [1, 5], time: "08:00", timezone: "UTC" });
assert.equal(custom.leadDays, 30);
assert.equal(custom.defaultMode, "deep");
assert.deepEqual(custom.autopilot, { enabled: true, approvePerWeek: 1, minScore: 70 });
assert.deepEqual([custom.weights.fit, custom.weights.trend], [3, 0]);
assert.deepEqual(custom.seedTopics, ["a"]);
assert.deepEqual(normalizeIdeaSettings({ cadence: { timezone: "Europe/Riga", time: "09:30" } }).cadence, { weekdays: [1, 4], time: "09:30", timezone: "Europe/Riga" });
assert.deepEqual(effectiveSeedTopics({ ...DEFAULT_IDEA_SETTINGS, seedTopics: ["SEO", "crm"] }, { topics: ["CRM"], editorialTopics: ["seo tips"] }), ["SEO", "crm", "seo tips"]);
assert.deepEqual(effectiveSeedTopics(DEFAULT_IDEA_SETTINGS, { name: "Lindevo", domain: "lindevo.com", topics: ["lindevo", "Projects", "services", "automation"] }), ["automation"], "brand and navigation words are dropped");

// sitemap
const map = parseSitemap(`<urlset><url><loc>https://c.test/blog/a-b-c</loc><lastmod>2026-11-01</lastmod></url><url><loc><![CDATA[https://c.test/x]]></loc></url><url><loc>https://c.test/unclosed`);
assert.deepEqual(map.entries, [{ loc: "https://c.test/blog/a-b-c", lastmod: "2026-11-01" }, { loc: "https://c.test/x", lastmod: undefined }]);
assert.equal(parseSitemap("<sitemapindex><sitemap><loc>https://c.test/s1.xml</loc></sitemap></sitemapindex>").index, true);

// collectors, each against fakes; one fails and one hangs without stopping the rest
const NOW = new Date("2026-11-05T12:00:00Z");
const dfs: DataForSeoClient = {
  serp: async () => [],
  keywordOverview: async (keyword) => ({ keyword, volume: 500, difficulty: 25, intent: "informational", aiOverview: false }),
  keywordIdeas: async () => [
    { keyword: "crm pricing", volume: 900, difficulty: 40, intent: "commercial", aiOverview: false },
    { keyword: "crm zero", volume: 0, difficulty: 1, intent: null, aiOverview: false },
  ],
  peopleAlsoAsk: async (q) => [`What is ${q}?`],
};
const baseDeps: CollectorDeps = {
  now: () => NOW, locale: "en", seeds: ["crm"], competitors: ["rival.test"],
  search: createFakeSearch({ crm: [{ url: "https://news.test/a?utm_source=x", title: "CRM news", snippet: "s" }] }),
  dataForSeo: dfs,
  fetchText: async (url) => url.endsWith("sitemap.xml")
    ? `<urlset><url><loc>https://rival.test/blog/crm-onboarding-checklist</loc><lastmod>2026-11-02</lastmod></url><url><loc>https://rival.test/old-page-here</loc><lastmod>2025-01-01</lastmod></url></urlset>`
    : "",
  fetchFeed: async () => [{ title: "Feed item about crm", url: "https://news.test/a", pubDate: "2026-11-04" }],
  gscQueries: async () => [{ query: "crm for plumbers", impressions: 120, clicks: 2, position: 14.26 }],
  feedUrls: async () => ["https://feed.test/rss"],
};
const all = await collectSignals(baseDeps);
const bySource = Object.fromEntries(all.reports.map((r) => [r.source, r.count]));
assert.deepEqual(bySource, { gsc: 1, news: 1, keywords: 1, paa: 1, rss: 1, competitor: 1 });
assert.equal(all.signals.find((s) => s.source === "gsc")?.metric?.position, 14.3);
assert.equal(all.signals.find((s) => s.source === "keywords")?.metric?.volume, 900);
assert.ok(all.signals.find((s) => s.source === "competitor")?.title.includes("crm onboarding checklist"));
assert.equal(all.signals.filter((s) => s.url?.includes("news.test/a")).length, 1, "a URL seen by two collectors is kept once");
assert.deepEqual(all.signals.map((s) => s.id), all.signals.map((_, i) => `s${i + 1}`));

const flaky = await collectSignals({
  ...baseDeps,
  gscQueries: async () => { throw new Error("db down"); },
  fetchFeed: () => new Promise(() => {}),
}, 50);
assert.equal(flaky.reports.find((r) => r.source === "gsc")?.error, "db down");
assert.equal(flaky.reports.find((r) => r.source === "rss")?.error, "timed out");
assert.equal(flaky.signals.length, 4, "the other collectors still deliver");
const scripted = await collectSignals({ ...baseDeps, fetchFeed: async () => [{ title: "Feed item with a script link", url: "javascript:alert(1)" }] });
assert.equal(scripted.signals.find((s) => s.source === "rss")?.url, undefined, "only http(s) URLs are kept");
const noDfs = await collectSignals({ ...baseDeps, dataForSeo: null });
assert.deepEqual([noDfs.reports.find((r) => r.source === "keywords")?.count, noDfs.reports.find((r) => r.source === "paa")?.count], [0, 0]);

const flood = mergeSignals([Array.from({ length: 400 }, (_, i) => ({ source: "news" as const, title: `topic number ${i} about x${i}`, summary: "" })), [{ source: "gsc" as const, title: "unique query phrase", summary: "" }]]);
assert.equal(flood.length, 150);
assert.ok(flood.some((s) => s.source === "gsc"), "round robin keeps small sources under the cap");

// candidates
const goodIdea = { title: "CRM onboarding checklist for plumbers", angle: "a", primaryKeyword: "crm onboarding", outline: ["a", "b", "c"], signalIds: ["s1", "s99"], fit: 8, gain: 6, demandEstimate: 7 };
const parsed = parseCandidates([goodIdea, { title: "x" }, { ...goodIdea, outline: ["only one"] }, { ...goodIdea, fit: 11 }, "junk"], [{ id: "s1" }]);
assert.equal(parsed.length, 1, "invalid ideas are dropped one by one");
assert.deepEqual(parsed[0].signalIds, ["s1"], "unknown signal ids are removed");
assert.deepEqual(parsed[0].alternateKeywords, []);
const llm = createFakeLlm({ brief: [{ ideas: [{ ...goodIdea, alternateKeywords: [], searchIntent: "informational", audienceQuestion: "q", whyNow: "", informationGain: [], rationale: "" }] }] });
const gen = await generateCandidates({ llm, model: "m", site: { name: "S", domain: "s.test", topics: ["crm"] }, postTitles: ["Old post"], signals: all.signals });
assert.equal(gen.candidates.length, 1);
const sent = llm.calls[0];
assert.equal(sent.role, "brief");
assert.ok(sent.user.includes("Old post") && sent.user.includes(all.signals[0].title));
assert.ok(/<data-[0-9a-f]+ label="signals">/.test(sent.user), "signals are fenced as untrusted data");

// scoring a batch
const cand = (over: object) => parseCandidates([{ ...goodIdea, ...over }], all.signals)[0];
const scored = scoreCandidates({
  candidates: [
    cand({ title: "CRM onboarding checklist for plumbers", signalIds: all.signals.map((s) => s.id) }),
    cand({ title: "Best CRM tools for startups 2026", primaryKeyword: "crm tools" }),
    cand({ title: "Best CRM tools for startups", primaryKeyword: "crm tools" }),
    cand({ title: "Plumber CRM onboarding checklist", primaryKeyword: "plumber crm" }),
    cand({ title: "Why dashboards fail", primaryKeyword: "dashboards", fit: 0 }),
  ],
  signals: all.signals,
  metrics: new Map([["crm onboarding", { keyword: "crm onboarding", volume: 1000, difficulty: 20, intent: "informational", aiOverview: false }]]),
  existingPosts: [{ id: "p1", title: "Best CRM tools for startups" }],
  existingIdeaTitles: ["CRM onboarding checklist for plumber"],
  weights: DEFAULT_WEIGHTS,
  now: NOW,
});
assert.deepEqual(scored.map((s) => s.candidate.title), ["Plumber CRM onboarding checklist"].concat(["Why dashboards fail"]),
  "an existing idea, and near-duplicates of a post, are skipped");
assert.equal(scored[1].score, 0, "a zero fit sinks the idea");
assert.equal(scored[0].origin, "discovered");
const refreshed = scoreCandidates({ candidates: [cand({ title: "CRM tools for startups compared" })], signals: [], metrics: new Map(), existingPosts: [{ id: "p1", title: "Best CRM tools for startups" }], existingIdeaTitles: [], weights: DEFAULT_WEIGHTS, now: NOW });
assert.equal(refreshed[0].origin, "refresh");
assert.equal(refreshed[0].nearest?.id, "p1");

// keyword metrics: signal data is reused, the rest looked up once, a failing lookup is isolated
let lookups = 0;
const counting: DataForSeoClient = { ...dfs, keywordOverview: async (keyword) => { lookups += 1; return { keyword, volume: 5, difficulty: 10, intent: null, aiOverview: false }; } };
const kwArgs = { dataForSeo: counting, locale: "xx", keywords: ["crm pricing", "Fresh Term"], signals: all.signals };
const metrics = await fetchKeywordMetrics(kwArgs);
assert.equal(metrics.get("crm pricing")?.volume, 900);
assert.equal(metrics.get("fresh term")?.volume, 5);
await fetchKeywordMetrics(kwArgs);
assert.equal(lookups, 1, "cached for the process");

// ledger metadata keeps counts, never text
assert.deepEqual(
  safeOperationMetadata("ideas.discovery", { signal_count: 9, idea_count: 3, cost_usd: 0.1, sources: "gsc,news", failed_collectors: 1, title: "secret", prompt: "x", error: "boom" }),
  { signal_count: 9, idea_count: 3, cost_usd: 0.1, sources: "gsc,news", failed_collectors: 1 },
);

console.log("ideas self-test passed");
