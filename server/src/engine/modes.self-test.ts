import assert from "node:assert/strict";
import { MODE_PRESETS, estimateRunUsd, parseEngineSettings, resolveRunSettings } from "./modes.js";

const { normal, deep } = MODE_PRESETS;
assert.ok(deep.maxRevise > normal.maxRevise);
assert.ok(deep.research.maxPages > normal.research.maxPages);
assert.equal(normal.estimateUsd.gates + normal.estimateUsd.deliver, 0);
assert.ok(estimateRunUsd("normal") < normal.budgetUsd && estimateRunUsd("deep") < deep.budgetUsd);

const r = resolveRunSettings("normal", { models: { draft: "x/y" }, budgetUsd: 2 });
assert.deepEqual(r.models, { ...normal.models, draft: "x/y" });
assert.equal(r.budgetUsd, 2);
assert.equal(r.citationStyle, "references");
assert.equal(resolveRunSettings("deep", {}).budgetUsd, 5);

assert.deepEqual(parseEngineSettings({ budgetUsd: -1, citationStyle: "footnotes" }), {});
assert.deepEqual(parseEngineSettings({ models: { draft: " a/b ", bogus: "z", brief: 3 }, budgetUsd: 3, citationStyle: "inline" }),
  { models: { draft: "a/b" }, budgetUsd: 3, citationStyle: "inline" });
assert.deepEqual(parseEngineSettings(null), {});

console.log("modes self-test passed");
