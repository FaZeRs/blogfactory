import assert from "node:assert/strict";
import { mapRow, type SourceRow } from "./import-lindevo-citations.js";

const site = { name: "Lindevo", domain: "lindevo.com" };
const base: SourceRow = {
  run_key: "2026-W40", question: "Best  tool?", engine: "gemini-grounded", answer: "Lindevo is good.",
  cited_urls: ["https://www.lindevo.com/a", "https://other.example/x"], lindevo_cited: true,
  lindevo_urls: ["https://lindevo.com/a"], asked_at: new Date("2026-10-01T00:00:00Z"),
};

const g = mapRow(base, site)!;
assert.equal(g.week, "2026-W40");
assert.equal(g.engine, "google/gemini (Lindevo import)");
assert.equal(g.engineLabel, "Google");
assert.equal(g.status, "ok");
assert.equal(g.cited, true);
assert.deepEqual(g.citedUrls, ["https://lindevo.com/a"]);
assert.deepEqual(g.otherHosts, ["other.example"]);
assert.equal(g.mentioned, true);
assert.equal(g.costUsd, 0);

const o = mapRow({ ...base, engine: "openai-web", answer: "  ", lindevo_cited: false, lindevo_urls: [] }, site)!;
assert.equal(o.engine, "openai/web (Lindevo import)");
assert.equal(o.engineLabel, "OpenAI");
assert.equal(o.status, "failed");
assert.equal(mapRow({ ...base, engine: "nope" }, site), null);
console.log("import-lindevo-citations self-test ok");
