import assert from "node:assert/strict";
import { classify, hostOf, mentions, normalizeUrl, siteHostMatch } from "./detect.js";
import { askEngine, EmptyAnswerError, EngineError, QuotaError, RateLimitError } from "./engines.js";
import { questionHash, validateQuestions } from "./questions.js";
import { normalizeVisibilitySettings } from "./settings.js";
import { isoWeek } from "./run.js";

// normalizeUrl / hostOf
assert.equal(normalizeUrl("https://User:pw@Lindevo.com/blog/post/?utm_source=x&gclid=1&page=2#top"), "https://lindevo.com/blog/post/?page=2".replace("post/?", "post?"));
assert.equal(normalizeUrl("https://lindevo.com/"), "https://lindevo.com");
assert.equal(normalizeUrl("ftp://lindevo.com/a"), null);
assert.equal(normalizeUrl("javascript:alert(1)"), null);
assert.equal(normalizeUrl("not a url"), null);
assert.equal(hostOf("https://www.Lindevo.com/x"), "lindevo.com");
assert.equal(hostOf("https://lindevo.com@evil.example/x"), "evil.example");

// host tricks
assert.ok(siteHostMatch("lindevo.com", "lindevo.com"));
assert.ok(siteHostMatch("www.lindevo.com", "lindevo.com"));
assert.ok(siteHostMatch("docs.lindevo.com", "lindevo.com"));
assert.ok(!siteHostMatch("lindevo.com.evil.example", "lindevo.com"));
assert.ok(!siteHostMatch("notlindevo.com", "lindevo.com"));
assert.equal(hostOf("https://evil.example/lindevo.com"), "evil.example");
assert.ok(!siteHostMatch(hostOf("https://evil.example/lindevo.com")!, "lindevo.com"));

// mentions
assert.ok(mentions("Try Lindevo for this.", ["lindevo"]));
assert.ok(mentions("see lindevo.com today", ["lindevo.com"]));
assert.ok(!mentions("Lindevonia is a place", ["lindevo"]));
assert.ok(!mentions("xlindevo", ["lindevo"]));
assert.ok(!mentions("an ab thing", ["ab"]), "short terms ignored");
assert.ok(mentions("(Lindevo), the tool", ["lindevo"]));

// classify
const c = classify({
  answer: "Lindevo is one option.",
  citations: [
    { url: "https://www.lindevo.com/a?utm_medium=z" }, { url: "https://lindevo.com/a" }, { url: "https://docs.lindevo.com/b" },
    { url: "https://Rival.com/x" }, { url: "https://www.rival.com/y" }, { url: "https://other.org" }, { url: "mailto:a@b.c" },
  ],
  domain: "lindevo.com", brandTerms: ["lindevo"], competitors: ["rival.com"],
});
assert.deepEqual(c.citedUrls, ["https://www.lindevo.com/a", "https://lindevo.com/a", "https://docs.lindevo.com/b"]);
assert.ok(c.cited && c.mentioned);
assert.deepEqual(c.otherHosts, ["rival.com", "other.org"]);
assert.deepEqual(c.competitorHosts, ["rival.com"]);
const none = classify({ answer: "nothing", citations: [], domain: "lindevo.com", brandTerms: ["lindevo"], competitors: [] });
assert.deepEqual([none.cited, none.mentioned, none.otherHosts], [false, false, []]);

// validateQuestions
const v = validateQuestions(
  ["  how   do I   book a crew ", "How do I book a crew?", "what is lindevo?", "hi", "x".repeat(201), "", "best crm for plumbers?"],
  ["Lindevo", "lindevo.com"],
);
assert.deepEqual(v.questions, ["how do I book a crew?", "best crm for plumbers?"]);
assert.deepEqual(v.errors.map((e) => e.index), [1, 2, 3, 4]);
const many = validateQuestions(Array.from({ length: 35 }, (_, i) => `question number ${i} here`), []);
assert.equal(many.questions.length, 30);
assert.equal(many.errors.length, 5);
assert.equal(questionHash("  Hello   World? "), questionHash("hello world?"));
assert.notEqual(questionHash("a?"), questionHash("b?"));

// settings
const s = normalizeVisibilitySettings({ engines: ["bad", "openai/gpt-5.6-luna", "A/B", "x/1", "x/2", "x/3", "x/4", "x/5"], weekday: 9, monthlyCapUsd: "no" }, { name: "Lindevo", domain: "lindevo.com" });
assert.deepEqual(s.engines, ["openai/gpt-5.6-luna", "x/1", "x/2", "x/3", "x/4"]);
assert.deepEqual([s.weekday, s.monthlyCapUsd, s.enabled], [1, 5, false]);
assert.deepEqual(s.brandTerms, ["Lindevo", "lindevo.com", "lindevo"]);
assert.equal(normalizeVisibilitySettings(null, { name: "N", domain: "n.example" }).engines.length, 3);
assert.doesNotThrow(() => normalizeVisibilitySettings(42, {}));

// isoWeek
assert.equal(isoWeek(new Date("2026-11-06T12:00:00Z")), "2026-W45");
assert.equal(isoWeek(new Date("2027-01-01T00:00:00Z")), "2026-W53");
assert.equal(isoWeek(new Date("2024-12-30T00:00:00Z")), "2025-W01");
assert.equal(isoWeek(new Date("2026-11-08T23:59:00Z")), "2026-W45");

// askEngine with a fake fetch
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const args = { apiKey: "k", model: "openai/x", question: "q?" };

let sent: any;
const ok = await askEngine({ ...args, fetchImpl: (async (_u: string, init: RequestInit) => {
  sent = JSON.parse(String(init.body));
  return new Response(JSON.stringify({
    model: "openai/x-2026", usage: { cost: 0.011 },
    choices: [{ message: { content: " Answer text ", annotations: [
      { type: "url_citation", url_citation: { url: "https://a.example/1", title: "One" } },
      { type: "url_citation", url_citation: { url: "https://a.example/1", title: "Dup" } },
      { type: "url_citation", url_citation: { url: "https://b.example/2" } },
    ] } }],
  }));
}) as unknown as typeof fetch });
assert.deepEqual(sent.plugins, [{ id: "web" }]);
assert.deepEqual(sent.usage, { include: true });
assert.equal(ok.answer, "Answer text");
assert.deepEqual(ok.citations, [{ url: "https://a.example/1", title: "One" }, { url: "https://b.example/2" }]);
assert.equal(ok.costUsd, 0.011);

const px = await askEngine({ ...args, fetchImpl: reply(200, { choices: [{ message: { content: "Hi" } }], citations: ["https://p.example/a", "https://p.example/a", "https://q.example"] }) });
assert.deepEqual(px.citations.map((x) => x.url), ["https://p.example/a", "https://q.example"]);
assert.equal(px.costUsd, 0);

await assert.rejects(askEngine({ ...args, fetchImpl: reply(429, { error: { message: "slow down" } }, { "retry-after": "7" }) }),
  (e: any) => e instanceof RateLimitError && e.retryAfterMs === 7000);
await assert.rejects(askEngine({ ...args, fetchImpl: reply(402, {}) }), QuotaError);
await assert.rejects(askEngine({ ...args, fetchImpl: reply(400, { error: { message: "Insufficient credits" } }) }), QuotaError);
await assert.rejects(askEngine({ ...args, fetchImpl: reply(200, { usage: { cost: 0.004 }, choices: [{ message: { content: "  " } }] }) }),
  (e: any) => e instanceof EmptyAnswerError && e.costUsd === 0.004);
await assert.rejects(askEngine({ ...args, fetchImpl: reply(500, "secret prompt echo question?") }),
  (e: any) => e instanceof EngineError && e.status === 500 && !/secret|question/.test(e.message));
await assert.rejects(askEngine({ ...args, fetchImpl: reply(200, { error: { code: 402, message: "no credits" } }) }), QuotaError);
await assert.rejects(askEngine({ ...args, fetchImpl: (async () => { throw new Error("boom with details"); }) as unknown as typeof fetch }),
  (e: any) => e instanceof EngineError && !/details/.test(e.message));

console.log("ai-visibility detect/engines/questions self-test passed");
