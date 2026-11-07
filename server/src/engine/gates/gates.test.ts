import { expect, test } from "bun:test";
import { renderCitations } from "../citations.js";
import { ENGINE_CONFIG } from "../config.js";
import { citationsGate } from "./citations.js";
import { runCodeGates } from "./index.js";
import { hrefsOf, linksGate } from "./links.js";
import { faqGate, metaGate } from "./meta.js";
import { overlapGate } from "./overlap.js";
import { similarityGate } from "./similarity.js";
import { structureGate } from "./structure.js";
import { type EvidenceItem, type GateInput, type SourceItem, gateBlockers } from "./types.js";
import { STYLE_PHRASES, styleGate } from "./style.js";
import { leaksGate } from "./leaks.js";
import { voiceGate } from "./voice.js";

const cfg = ENGINE_CONFIG.gates;
const SITE = "https://blog.example";
const sources: SourceItem[] = [1, 2, 3].map((n) => ({
  finalUrl: `https://src${n}.example/p`,
  id: `s${n}`,
  markdown: `Source ${n} says something entirely unrelated to the article text. `.repeat(30),
  title: `Source ${n}`,
  url: `https://src${n}.example/p`,
}));
const evidence: EvidenceItem[] = [1, 2, 3].map((n) => ({
  claim: `claim ${n}`,
  id: `c${n}`,
  quote: "q",
  sourceId: `s${n}`,
  verified: true,
}));

// Distinct words per sentence so nothing overlaps or repeats across the body.
const sentence = (i: number) => `Paragraph ${i} explores topic${i} with detail${i} and example${i} for readers${i} today.`;
const body = Array.from({ length: 150 }, (_, i) => sentence(i)).join(" ");
const faq = [
  "## Frequently Asked Questions",
  "### Does it work for small teams?",
  "Yes. Small teams use it every day to save hours on routine work.",
  "### Is a human involved at the end?",
  "Yes. A person reviews every draft before anything goes out to readers.",
  "### How long does setup take?",
  "Setup takes about an hour including the connection to your site.",
].join("\n\n");
const raw = `${body} Fact one {{c:c1}}. Fact two {{c:c2}}. Fact three {{c:c3}}.\n\n${faq}`;
const markdown = renderCitations(raw, evidence, sources, "inline", "en");
const input: GateInput = {
  description: "A short description.",
  evidence,
  existingPosts: [],
  markdown,
  raw,
  siteUrl: SITE,
  sources,
  title: "A fine title",
};
const ok = () => Promise.resolve(200);
const messages = (r: { issues: { message: string }[] }) => r.issues.map((i) => i.message).join("\n");

test("a clean article passes every code gate, in a fixed order", async () => {
  const results = await runCodeGates(input, { checkLink: ok, config: ENGINE_CONFIG });
  expect(results.map((r) => r.gate)).toEqual([
    "structure", "meta", "faq", "voice", "voice-warnings", "style", "style-warnings", "leaks", "leaks-warnings", "citations", "links", "links-warnings", "overlap", "similarity",
  ]);
  expect(gateBlockers(results)).toEqual([]);
  expect(results.find((r) => r.gate === "meta")?.metrics?.words).toBeGreaterThan(cfg.minWords);
});

test("structure: H1 and provenance fail; code is ignored", () => {
  expect(structureGate("# Title\n\ntext").passed).toBe(false);
  expect(structureGate("text <provenance sources=\"1\"></provenance>").passed).toBe(false);
  expect(structureGate("```\n# comment\n```\n\ntext").passed).toBe(true);
});

test("meta and faq limits", () => {
  expect(metaGate({ ...input, title: "x".repeat(61) }, cfg).passed).toBe(false);
  expect(metaGate({ ...input, description: "x".repeat(156) }, cfg).passed).toBe(false);
  expect(messages(metaGate({ ...input, markdown: "short" }, cfg))).toContain("words");
  expect(faqGate(markdown, cfg).passed).toBe(true);
  expect(faqGate(markdown.replace(/Yes\. Small[^\n]+/, "Yes."), cfg).passed).toBe(false);
  expect(faqGate("no faq here", cfg).passed).toBe(false);
});

test("voice: hype blocks, 'AI agents' only warns", () => {
  expect(voiceGate("Our AI-powered tool", ENGINE_CONFIG.voice)[0]?.passed).toBe(false);
  const [blockers, warnings] = voiceGate("How AI agents draft replies", ENGINE_CONFIG.voice);
  expect(blockers?.passed).toBe(true);
  expect(warnings?.passed).toBe(false);
  expect(warnings?.severity).toBe("warning");
});

test("citations: unresolved markers, too few sources, unverified claims and a missing link fail", () => {
  const r = "Claim {{c:c1}}. Claim {{c:c9}}.";
  const bad = citationsGate({ evidence, markdown: renderCitations(r, evidence, sources, "inline", "en"), raw: r, sources });
  expect(messages(bad)).toContain("unresolved");
  expect(messages(bad)).toContain("distinct verified sources");
  const un = "A {{c:c5}}.";
  const ev5 = [...evidence, { ...evidence[0], id: "c5", verified: false } as EvidenceItem];
  expect(messages(citationsGate({ evidence: ev5, markdown: un, raw: un, sources }))).toContain("unverified claim");
  const three = "One {{c:c1}}. Two {{c:c2}}. Three {{c:c3}}.";
  const good = citationsGate({ evidence, markdown: renderCitations(three, evidence, sources, "references", "en"), raw: three, sources });
  expect(good.passed).toBe(true);
  expect(good.metrics).toEqual({ citedSources: 3, markers: 3 });
  expect(messages(citationsGate({ evidence, markdown: "One. Two. Three.", raw: three, sources }))).toContain("does not link");
});

test("links: cited sources are not re-fetched; 404 and no response block; 403 and bad schemes behave", async () => {
  const calls: string[] = [];
  const table: Record<string, number> = { "https://dead.example/x": 404, "https://wall.example/": 403, "https://down.example/": 0 };
  const checkLink = (u: string) => {
    calls.push(u);
    return Promise.resolve(table[u] ?? 200);
  };
  const md = "[s](https://src1.example/p) [d](https://dead.example/x) [w](https://wall.example/) [n](https://down.example/) [m](mailto:a@b.c) [r](/about)";
  const [links, warnings] = await linksGate({ evidence, markdown: md, siteUrl: SITE, sources }, { checkLink });
  expect(calls).not.toContain("https://src1.example/p");
  expect(calls).toContain("https://blog.example/about");
  expect(messages(links!)).toContain("dead.example");
  expect(messages(links!)).toContain("no response");
  expect(messages(links!)).toContain("unsupported link scheme");
  expect(messages(links!)).not.toContain("wall.example");
  expect(links?.passed).toBe(false);
  expect(warnings?.passed).toBe(false);
  expect(warnings?.severity).toBe("warning");
  expect(messages(warnings!)).toContain("wall.example");
});

test("hrefsOf ignores images and code, and keeps balanced parentheses", () => {
  expect(hrefsOf("![i](https://a.example/i.png) `[x](https://b.example)` [w](https://c.example/a_(b)) <https://d.example/>")).toEqual([
    "https://c.example/a_(b)",
    "https://d.example/",
  ]);
});

test("overlap: a copied run and a high share block; quotes and unused sources do not", () => {
  const copied = sources[0]!.markdown.split(" ").slice(0, 60).join(" ");
  const own = Array.from({ length: 40 }, (_, i) => sentence(i + 500)).join(" ");
  const r = overlapGate({ evidence, markdown: `${own} ${copied}`, sources }, cfg);
  expect(r.passed).toBe(false);
  expect(messages(r)).toContain("word run is copied");
  expect(overlapGate({ evidence, markdown: `${own}\n\n> ${copied}`, sources }, cfg).passed).toBe(true);
  expect(overlapGate({ evidence: [], markdown: `${own} ${copied}`, sources }, cfg).passed).toBe(true);
  // Latvian quotes (low-9 opener, curly closer) also exempt a quoted span.
  expect(overlapGate({ evidence, markdown: `${own} „${copied}“`, sources }, cfg).passed).toBe(true);
});

test("similarity gate blocks a near-copy of an existing post and passes a new one", () => {
  const base = "Automating order emails into a spreadsheet saves small teams hours every week ".repeat(20);
  expect(similarityGate({ ...input, existingPosts: [{ content: base, id: "p1", title: "x" }], markdown: base }, cfg).passed).toBe(false);
  const fresh = "A completely different article about cooking pasta at home ".repeat(20);
  const r = similarityGate({ ...input, existingPosts: [{ content: base, id: "p1", title: "x" }], markdown: fresh }, cfg);
  expect(r.passed).toBe(true);
  expect(r.metrics?.maxSimilarity).toBeLessThan(cfg.similarityMax);
});

test("style: 3 phrase hits or too many em dashes block; 1-2 hits only suggest; code and URLs are ignored", () => {
  const filler = Array.from({ length: 200 }, (_, i) => `Plain sentence number ${i} about topic${i}.`).join(" ");
  expect(STYLE_PHRASES.length).toBeGreaterThanOrEqual(25);
  const [clean, cleanWarn] = styleGate(filler);
  expect(clean?.passed && cleanWarn?.passed).toBe(true);

  const [one, oneWarn] = styleGate(`${filler} Let us Delve into the details. It is worth noting that it works.`);
  expect(one?.passed).toBe(true);
  expect(oneWarn?.issues).toHaveLength(2);
  expect(oneWarn?.issues[0]?.excerpt?.length).toBeLessThanOrEqual(160);

  const three = styleGate(`${filler} We delve into it. Seamlessly done. This is a game changer for teams.`);
  expect(three[0]?.passed).toBe(false);
  expect(three[0]?.issues).toHaveLength(3);
  expect(three[1]?.passed).toBe(true);
  expect(gateBlockers(three)[0]?.gate).toBe("style");

  const dashed = `${filler} ${"A short clause \u2014 then another. ".repeat(15)}`;
  expect(styleGate(dashed)[0]?.passed).toBe(false);
  expect(styleGate(`${filler} One clause \u2014 one dash.`)[0]?.passed).toBe(true);

  const ignored = `${filler}\n\n\`\`\`\ndelve seamlessly tapestry\n\`\`\`\n\nSee [the page](https://x.example/delve-seamlessly-tapestry).`;
  expect(styleGate(ignored).every((r) => r.passed)).toBe(true);
  // A hit in the very first sentence keeps its first character.
  expect(styleGate(`Delve into this. ${filler}`)[1]?.issues[0]?.excerpt).toStartWith("Delve into this.");
});

test("a site's banned phrases block anywhere, banned words only as whole words", async () => {
  const { voiceGate, withSiteVoice } = await import("./voice.js");
  const voice = withSiteVoice(ENGINE_CONFIG.voice, { bannedPhrases: ["booking engine"], bannedWords: ["seamless", "tu"] });
  const issues = (text: string) => voiceGate(text, voice).find((r) => r.gate === "voice")!.issues.map((i) => i.excerpt);
  expect(issues("A Booking Engine for hotels.")).toEqual(["Booking Engine"]);
  expect(issues("A seamless setup.")).toEqual(["seamless"]);
  expect(issues("Seamlessly done on Tuesday, tune it.")).toEqual([]);
  expect(withSiteVoice(ENGINE_CONFIG.voice, {})).toBe(ENGINE_CONFIG.voice);
});

test("style blocks dense prose: an average over 22 words a sentence names the longest sentences", async () => {
  const { styleGate, proseSentences } = await import("./style.js");
  const long = "This sentence keeps going with one clause after another, which is the habit that makes plain articles hard to read for a busy owner who just wants the answer.";
  const short = "This sentence is short and clear. It says one thing.";
  const dense = Array.from({ length: 12 }, () => `${long} ${long}`).join("\n\n");
  const plain = Array.from({ length: 12 }, () => `${short} ${short}`).join("\n\n");
  const issues = (md: string) => styleGate(md).find((r) => r.gate === "style")!.issues;
  expect(issues(dense).length).toBe(5);
  expect(issues(dense)[0]!.message).toMatch(/sentences average 29/);
  expect(issues(plain)).toEqual([]);
  // Two-sentence paragraphs of 15 words pass; walls of 4 long-ish sentences (60 words) are split.
  const mid = "This sentence has a fair number of words in it, fifteen in all here.";
  const walls = Array.from({ length: 16 }, () => [mid, mid, mid, mid].join(" ")).join("\n\n");
  expect(issues(walls).map((i) => i.message)[0]).toMatch(/paragraphs average 56 words/);
  expect(issues(Array.from({ length: 16 }, () => `${mid} ${mid}`).join("\n\n"))).toEqual([]);
  expect(proseSentences("## Heading\n\n- a list item that is long enough\n\n<key-takeaways>\n\nOne real sentence here[¹](https://x.example).{{c:c1}} Another one follows.")).toEqual(["One real sentence here.", "Another one follows."]);
  // Code is not prose, even where a blank line splits a fence; a sentence may open with a number.
  const { proseParagraphs } = await import("./style.js");
  expect(proseParagraphs("Intro sentence with five words.\n\n```js\nconst total = price * count + tax;\n\nconst shown = total.toFixed(2) + unit;\n```\n")).toEqual(["Intro sentence with five words."]);
  expect(proseSentences("The first one is here. 10 more words come next.")).toEqual(["The first one is here.", "10 more words come next."]);
});

const leak = (md: string, extra: Partial<GateInput> = {}) => leaksGate({ ...input, markdown: md, ...extra });
const blocked = (md: string) => leak(md)[0]?.issues ?? [];

test("leaks: every secret detector blocks, with a masked excerpt", () => {
  const secrets = [
    "sk-proj1234567890abcdefghij",
    "sk-ant-api03-abcdefghijklmnop1234",
    "ghp_abcdefghijklmnopqrstuvwxyz1234",
    "github_pat_11ABCDEFG0abcdefghijklmn",
    "AKIAQWERTYUIOPASDFGH",
    "xoxb-1234567890-abcdefghij",
    "sk_live_abcdefghij1234567890",
    "rk_live_abcdefghij1234567890",
    "AIzaSyA1234567890abcdefghijklmnopqrstu",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "password=Hunter2isGreat",
    "https://admin:s3cretpw@db.corp.net/x",
    "https://admin:S3curePassword42@samples.acme.io",
    "secret: Summer2024rocks",
    "api_key: 'longsecretvaluewithoutdigits'",
    "https://api.site.com/v1?token=abcdef1234567890abcd",
  ];
  for (const s of secrets) {
    const [b] = leak(`Use \`${s}\` here.`);
    expect(b?.passed, s).toBe(false);
    expect(b?.severity).toBe("blocker");
    expect(JSON.stringify(b)).not.toContain(s);
    expect(b?.issues[0]?.excerpt?.length).toBeLessThanOrEqual(5);
  }
  // Setup guides show local addresses on purpose: a warning, not a blocker.
  for (const host of ["192.168.1.20", "10.0.0.5", "http://localhost:3000", "db01.internal", "build.corp", "nas.local"]) {
    const [b, w] = leak(`Open \`${host}\` in a browser.`);
    expect(b?.passed, host).toBe(true);
    expect(w?.passed, host).toBe(false);
    expect(w?.severity).toBe("warning");
  }
  const key = leak("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")[0];
  expect(key?.passed).toBe(false);
  expect(gateBlockers([key as never])[0]?.fix).toBe("Remove the private key");
});

test("leaks: title, description and code blocks are scanned", () => {
  expect(leak("text", { title: "ghp_abcdefghijklmnopqrstuvwxyz1234" })[0]?.passed).toBe(false);
  expect(leak("text", { description: "10.1.2.3" })[1]?.passed).toBe(false);
  expect(blocked("```\nAKIAQWERTYUIOPASDFGH\n```")).toHaveLength(1);
});

test("leaks: placeholders and look-alikes pass", () => {
  const fine = [
    "Set OPENAI_API_KEY=YOUR_API_KEY and sk-... in .env",
    "api_key=xxxxxxxxxxxx and token: <token>",
    "password=${PASSWORD} or password=getPassword()",
    "AKIAIOSFODNN7EXAMPLE",
    "risk-assessment-framework-for-teams",
    "Visit https://example.com/?key=marketing-automation-tools or 8.8.8.8",
    "In 2024 we paid $1,299.00 for v10.2.3.4 of the tool, ISBN 978-3-16-148410-0.",
    "Call +1 555 123 4567 or email jane@example.com",
    "The secret: cross-functional collaboration makes teams effective.",
    "Connect to https://user:pass1234@db.example.com or https://u:p4ssword@app.test",
    "Connect to `https://user:pass1234@db.example.com`, or [the app](https://u:p4ssword@app.test).",
    "Set GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxx and SLACK_TOKEN=xoxb-xxxxxxxxxxxx",
    "![logo](logo@2x.png) needs react@18.2.0",
  ];
  for (const md of fine) expect(leak(md).every((r) => r.passed), md).toBe(true);
});

test("leaks: emails and phones only warn; own-domain role address is allowed", () => {
  const [b, w] = leak("Write to jane.doe@acme.io or call +44 20 7946 0958.");
  expect(b?.passed).toBe(true);
  expect(w?.severity).toBe("warning");
  expect(w?.issues).toHaveLength(2);
  expect(JSON.stringify(w)).not.toContain("jane.doe@acme.io");
  expect(gateBlockers([b as never, w as never])).toEqual([]);
  expect(leak("Mail hello@acme.io", { siteUrl: "https://www.acme.io" })[1]?.passed).toBe(true);
  expect(leak("Mail jane@acme.io", { siteUrl: "https://www.acme.io" })[1]?.passed).toBe(false);
  // A credential URL is the blocker's; the email rule must not store a piece of its password.
  const [cb, cw] = leak("Use https://admin:s3cretpw@db.acme.io/x or mailto:jane@acme.io");
  expect(cb?.passed).toBe(false);
  expect(cw?.issues).toHaveLength(1);
  expect(JSON.stringify(cw)).not.toContain("s3cr");
});
