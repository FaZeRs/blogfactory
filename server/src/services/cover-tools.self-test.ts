import assert from "node:assert/strict";
import { COVER_PRESETS, COVER_STYLE_DEFAULTS, adjustCoverPrompt, cleanCoverPrompt, coverPromptDraft, siteDefaultCoverStyle } from "./cover-tools.js";

assert.deepEqual(COVER_PRESETS.map((p) => p.id), ["site_default", "editorial_photo", "flat_illustration", "3d_render", "abstract", "brand_colors"]);
assert.ok(!COVER_STYLE_DEFAULTS.includes("site_default") && COVER_STYLE_DEFAULTS.includes("custom"));

const settings = { imageStylePrompt: "Warm pastel.", brandCompanyName: "Acme", brandDescription: "Rocket skates", imageAdvancedOptions: {} };
const draft = (preset: string, s = settings) => coverPromptDraft({ title: "My Post", content: "body", preset, settings: s });
assert.match(draft("flat_illustration"), /Flat vector illustration/);
assert.match(draft("brand_colors"), /Acme: Rocket skates/);
assert.match(draft("brand_colors"), /Warm pastel\./);
assert.match(draft("site_default"), /Warm pastel\./, "unset site default uses the Article Settings style");
assert.match(draft("site_default", { ...settings, imageAdvancedOptions: { coverStylePreset: "abstract" } }), /Abstract composition/);
assert.equal(siteDefaultCoverStyle({ imageAdvancedOptions: { coverStylePreset: "bogus" } }), "custom");
assert.match(draft("abstract"), /cover for "My Post"/);

assert.equal(cleanCoverPrompt("short"), null);
assert.equal(cleanCoverPrompt(42), null);
assert.equal(cleanCoverPrompt("  a\u0000b\u0007c line one\nline two  "), "abc line one\nline two");
assert.equal(cleanCoverPrompt("x".repeat(3000))?.length, 2000);
assert.match(adjustCoverPrompt("make it blue"), /^Edit this image: make it blue\./);
console.log("cover-tools self-test ok");
