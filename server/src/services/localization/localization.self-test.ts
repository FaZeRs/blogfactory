import assert from "node:assert/strict";
import { ENGINE_CONFIG } from "../../engine/config.js";
import { gateBlockers } from "../../engine/gates/types.js";
import { asciiSlug, citationsGate, faqGate, formalAddressGate, metaGate, parityGate, repeatedStems, toFindings, translationChecks } from "./checks.js";
import { pickKeyword, keywordMarketKnown } from "./keyword.js";
import { localizeBlogLinks, untranslatedBlogLinks } from "./links.js";
import { patchTranslation } from "./patch.js";
import { summarizeChange } from "./localize.js";
import { LIMITS, activeLocales, normalizeLocalization } from "./settings.js";

// ── settings: never throws, caps everything ──
assert.deepEqual(normalizeLocalization(undefined), { enabled: false, locales: [] });
assert.deepEqual(normalizeLocalization("x"), { enabled: false, locales: [] });
assert.deepEqual(normalizeLocalization(null), { enabled: false, locales: [] });
{
  const long = "x".repeat(500);
  const s = normalizeLocalization({
    enabled: true,
    locales: [
      { locale: "lv", name: "Latvian".repeat(20), glossary: [{ source: " AI system ", target: "AI sistēma", note: long }, { source: "", target: "x" }, { source: "a" }, null], styleGuide: "s".repeat(30_000), formalAddress: { forbidden: ["tu", "tu", " tev ", 5, ...Array.from({ length: 60 }, (_, i) => `w${i}`)] } },
      { locale: "LV", name: "bad code" },
      { locale: "lv", name: "duplicate" },
      { locale: "pt-BR", name: "Portuguese" },
      { locale: "de" },
      { locale: "fr", name: "fourth" },
    ],
  });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.locales.map((l) => l.locale), ["lv", "pt-BR", "de"], "bad codes and duplicates drop, at most 3 locales");
  const lv = s.locales[0]!;
  assert.equal(lv.name.length, LIMITS.name);
  assert.equal(lv.glossary.length, 1);
  assert.equal(lv.glossary[0]!.source, "AI system");
  assert.equal(lv.glossary[0]!.note!.length, LIMITS.note);
  assert.equal(lv.styleGuide.length, LIMITS.styleGuide);
  assert.equal(lv.formalAddress!.forbidden.length, LIMITS.forbidden);
  assert.deepEqual(lv.formalAddress!.forbidden.slice(0, 2), ["tu", "tev"]);
  assert.equal(s.locales[2]!.name, "de", "a missing name falls back to the code");
  assert.equal(normalizeLocalization({ enabled: "yes", locales: "x" }).enabled, false);
  assert.equal(normalizeLocalization({ locales: Array.from({ length: 300 }, () => ({ locale: "lv", glossary: Array.from({ length: 300 }, (_, i) => ({ source: `a${i}`, target: "b" })) })) }).locales[0]!.glossary.length, LIMITS.glossary);
  assert.deepEqual(activeLocales({ enabled: false, locales: s.locales }), []);
  assert.equal(activeLocales(s).length, 3);
}

// ── patch: the rules ──
const MD = [
  "Sistēma atbalsta melnrakstu veidošanu ar cilvēka pārbaude katru dienu.",
  "",
  "Skatiet, [kā Lindevo strādā ar klientu](/how-we-work). Dati rāda pieaugumu.[¹](https://stat.example/ai-2025) Vēl {{c:claim-1}} paliek.",
  "",
  '<workflow title="No klienta jautājuma līdz atbildei">',
  "",
  '<workflow-step kind="human" title="Cilvēks pārbauda">',
  "Komandas loceklis apstiprina melnrakstu.",
  "</workflow-step>",
  "",
  "</workflow>",
  "",
  "Palaidiet `npm run pārbaude` komandu.",
  "",
  "```",
  "kods ar pārbaudes vārdu",
  "```",
  "",
  "Atbildīgā persona pārbauda. Atbildīgā persona apstiprina.",
].join("\n");
const LV = { description: "Kā komanda var sagatavot atbildes ar cilvēka pārbaude un ietaupīt laiku katru nedēļu.", markdown: MD, title: "Atbildes ar cilvēka apstiprinājumu" };
const one = (excerpt: string, fix: string, field?: "markdown" | "title" | "description") => patchTranslation(LV, [{ excerpt, fix, ...(field ? { field } : {}) }]);

{
  const out = one("veidošanu ar cilvēka pārbaude", "veidošanu ar cilvēka pārbaudi");
  assert.equal(out?.patched, 1);
  assert.ok(out!.text.markdown.includes("veidošanu ar cilvēka pārbaudi katru dienu."));
  assert.equal(out!.text.title, LV.title);
  assert.equal(out!.text.description, LV.description, "a fix without a field is a markdown fix");
}
assert.equal(one("ar cilvēka pārbaude un", "ar cilvēka pārbaudi un"), null, "a quote only in the description is not in the markdown");
{
  const long = { ...LV, description: "D".repeat(400) };
  assert.equal(patchTranslation(long, [{ excerpt: long.description, field: "description", fix: "E".repeat(600) }]), null, "a field fix cannot break the field's limits");
}
assert.equal(one(LV.title, "B".repeat(250), "title"), null);
assert.equal(one("Atbildes ar cilvēka apstiprinājumu", "Atbildes ar cilvēka pārbaudi", "title")?.text.title, "Atbildes ar cilvēka pārbaudi");
// an ellipsis at both ends marks a cut; at one end only the texts do not line up
assert.ok(one("…veidošanu ar cilvēka pārbaude", "…veidošanu ar cilvēka pārbaudi")?.text.markdown.includes("veidošanu ar cilvēka pārbaudi katru"));
assert.equal(one("...cilvēka pārbaude katru...", "...cilvēka pārbaudi katru...")?.patched, 1);
assert.equal(one("…veidošanu ar cilvēka pārbaude", "veidošanu ar cilvēka pārbaudi"), null);
assert.equal(one("veidošanu ar cilvēka pārbaude", "…pārbaudi"), null);
// twice, not at all, or inside a longer word
assert.equal(one("Atbildīgā persona", "Atbildīgais cilvēks"), null, "found twice");
assert.equal(one("nav šajā tekstā", "ir šajā tekstā"), null, "found nowhere");
assert.equal(one("ar cilvēka pārbaud", "ar cilvēka pārbaudīt"), null, "inside a longer word");
// protected spans
for (const [q, f] of [
  ["/how-we-work", "/ka-mes-stradajam"], ["claim-1", "claim-2"], ["pieaugumu.[¹](https://stat.example/ai-2025)", "kāpumu.[¹](https://stat.example/ai-2025)"],
  ["stat.example/ai-2025", "stat.example/ai-2026"], ["No klienta jautājuma", "No klienta vaicājuma"], ["Cilvēks pārbauda", "Cilvēks pārskata"],
  ["npm run pārbaude", "npm run pārbaudi"], ["kods ar pārbaudes vārdu", "kods ar pārbaudes vārdiem"],
] as const) assert.equal(one(q, f), null, `protected: ${q}`);
assert.ok(one("kā Lindevo strādā ar klientu", "kā Lindevo strādā ar klientiem")?.text.markdown.includes("[kā Lindevo strādā ar klientiem](/how-we-work)"), "link text is ordinary text");
assert.equal(one("apstiprina melnrakstu", "apstiprina melnrakstus")?.patched, 1, "a component's children are ordinary text");
// a fix that changes markup, spans lines, equals the quote, is empty or is advice
assert.equal(one("ar cilvēka pārbaude", "ar **cilvēka** pārbaudi"), null);
assert.equal(one("ar cilvēka pārbaude", "ar cilvēka\npārbaudi"), null);
assert.equal(one("pārbaude katru", "pārbaude katru"), null);
assert.equal(one("", "pārbaudi"), null);
assert.equal(one("pārbaude katru", ""), null);
assert.equal(one("pārbaude katru", "Lietojiet akuzatīvu pēc prepozīcijas 'ar': pārbaudi katru, jo tā prasa vienskaitļa akuzatīvu"), null);
{
  const out = patchTranslation(LV, [
    { excerpt: "ar cilvēka pārbaude", fix: "ar cilvēka pārbaudi" },
    { excerpt: "Atbildīgā persona", fix: "Atbildīgais" },
    { excerpt: "apstiprina melnrakstu", fix: "apstiprina melnrakstus" },
  ]);
  assert.equal(out?.patched, 2, "applied in order; the ones that cannot apply are skipped");
  assert.ok(out!.text.markdown.includes("Atbildīgā persona pārbauda."));
}

// ── repeat check ──
assert.deepEqual(repeatedStems("## Soļi\n\nAtjaunināt jāatjaunina dokumenti katru mēnesi.", "lv"), ["Atjaunināt jāatjaunina"]);
assert.deepEqual(repeatedStems("Atjaunināt jāatjaunina dokumenti", "de"), [], "the jā prefix is ignored for Latvian only");
assert.deepEqual(repeatedStems("Ievākt datus un dokumentus", "lv"), []);
assert.deepEqual(repeatedStems("Jūsu darba plūsma ir vienkārša. Pārbaudiet dokumentus, pārbaudiet datus. Skatiet [automatizācija](https://example.com/automatizacija) `automatizācija automatizācija`.", "lv"), []);

// ── links ──
const slugs = new Map([["reliable-ai-workflows", "uzticamas-mi-darbplusmas"], ["first-automation", "pirma-automatizacija"]]);
assert.equal(
  localizeBlogLinks("Lasiet [a](/blog/reliable-ai-workflows) un [b](/blog/first-automation#sakums).", slugs, "lv"),
  "Lasiet [a](/lv/blog/uzticamas-mi-darbplusmas) un [b](/lv/blog/pirma-automatizacija#sakums).",
);
{
  const same = "[a](/lv/blog/pirma-automatizacija) [b](/blog/no-translation) [c](/how-we-work) [d](https://example.com/blog/first-automation) [e](/blog/first-automation-extra)";
  assert.equal(localizeBlogLinks(same, slugs, "lv"), same, "unknown and foreign links stay");
  const code = "`[t](/blog/first-automation)` [x](/blog/first-automation)\n\n```md\n[k](/blog/reliable-ai-workflows)\n```";
  assert.equal(localizeBlogLinks(code, slugs, "de"), "`[t](/blog/first-automation)` [x](/de/blog/pirma-automatizacija)\n\n```md\n[k](/blog/reliable-ai-workflows)\n```", "code is left as written");
  assert.deepEqual(untranslatedBlogLinks("[b](/blog/no-translation) `[c](/blog/in-code)` [d](/lv/blog/x)"), ["/blog/no-translation"]);
}

// ── keyword ──
assert.deepEqual(pickKeyword([{ keyword: "a", volume: 10 }, { keyword: "b", volume: 90 }, { keyword: "c", volume: 90 }]), { keyword: "b", volume: 90 });
assert.deepEqual(pickKeyword([{ keyword: "a", volume: 0 }, { keyword: "b", volume: null }]), { keyword: "a", volume: 0 }, "all zero or unknown keeps the model's first");
assert.equal(pickKeyword([]), null);
assert.equal(keywordMarketKnown("lv"), true);
assert.equal(keywordMarketKnown("de"), false, "an unknown market is never measured in the wrong one");

// ── slug ──
assert.equal(asciiSlug("Ātri un viegli: Ķēķis, ļoti!"), "atri-un-viegli-kekis-loti");
assert.equal(asciiSlug("Straße Łódź"), "strasse-lodz");
assert.equal(asciiSlug("日本語"), "");

// ── change summary ──
assert.equal(summarizeChange("A\n\nB\n\nC", "A\n\nB2\n\nC").split("\n").length, 2);
assert.ok(summarizeChange("A", "A").startsWith("No paragraph changed"));

// ── checks ──
const cfg = ENGINE_CONFIG.gates;
const EN = [
  "Intro paragraph with a claim.[¹](https://s1.example/a) Another one.[²](https://s2.example/b)",
  "## First part",
  "- one\n- two\n- three",
  "> a quote",
  "## Frequently Asked Questions",
  "### Is it good?",
  "Yes, it is a good thing for most small teams to do early.",
  "### Is it cheap?",
  "It is cheap enough for most small teams to try this month.",
  "### Is it fast?",
  "It is fast enough that a team sees results within a week.",
  "## Sources",
  "1. [Source A](https://s1.example/a) — s1.example\n2. [Source B](https://s2.example/b) — s2.example",
].join("\n\n");
const TR = [
  "Ievads ar apgalvojumu.[¹](https://s1.example/a) Vēl viens.[²](https://s2.example/b)",
  "## Pirmā daļa",
  "- viens\n- divi\n- trīs",
  "> citāts",
  "## Biežāk uzdotie jautājumi",
  "### Vai tas ir labi?",
  "Jā, tas ir labi lielākajai daļai mazo komandu, ja sāk laikus.",
  "### Vai tas ir lēti?",
  "Tas ir pietiekami lēts, lai komanda to izmēģinātu šomēnes.",
  "### Vai tas ir ātri?",
  "Tas ir pietiekami ātri, lai komanda redzētu rezultātu nedēļas laikā.",
  "## Avoti",
  "1. [Avots A](https://s1.example/a) — s1.example\n2. [Avots B](https://s2.example/b) — s2.example",
].join("\n\n");
const failing = (r: { passed: boolean }) => !r.passed;
assert.equal(parityGate(EN, TR, "markdown").passed, true);
assert.equal(parityGate(EN, TR.replace("## Pirmā daļa", "### Pirmā daļa"), "markdown").passed, false, "a heading level changed");
assert.equal(parityGate(EN, TR.replace("> citāts\n\n", ""), "markdown").passed, false, "a blockquote dropped");
assert.equal(parityGate(EN, TR.replace("- trīs", ""), "markdown").passed, false, "a list item dropped");
assert.equal(parityGate(EN, TR, "lindevo").passed, true, "the Lindevo profile lints components and parity");
assert.equal(parityGate(`${EN}\n\n<key-takeaways>\n\n- a\n\n</key-takeaways>`, TR, "lindevo").passed, false, "a missing component");
assert.equal(citationsGate(EN, TR).passed, true);
assert.equal(citationsGate(EN, TR.replace("[¹](https://s1.example/a)", "")).passed, false, "a dropped mark");
assert.equal(citationsGate(EN, TR.replace(/\[²\]\(https:\/\/s2\.example\/b\)/, "[³](https://s2.example/b)")).passed, false, "a renumbered mark");
assert.equal(citationsGate(EN, TR.replace("https://s2.example/b)", "https://s2.example/c)")).passed, false, "a changed destination");
assert.equal(citationsGate(EN, TR.replace(/## Avoti[\s\S]*$/, "")).passed, false, "no sources list");
assert.equal(citationsGate(EN, `${TR}\n\n## Sources\n\n1. [A](https://s1.example/a)\n2. [B](https://s2.example/b)`).passed, false, "the sources list twice");
assert.equal(citationsGate(EN, `${TR} {{c:c1}}`).passed, false, "a leftover marker");
assert.equal(metaGate({ title: "T".repeat(cfg.titleMax), description: "d", slug: "ok-slug", markdown: TR }, { title: "t", description: "d", markdown: EN }, cfg).passed, true);
assert.equal(metaGate({ title: "T".repeat(cfg.titleMax + 1), description: "d", slug: "ok", markdown: TR }, { title: "t", description: "d", markdown: EN }, cfg).passed, false);
assert.equal(metaGate({ title: "t", description: "d".repeat(cfg.descriptionMax + 1), slug: "ok", markdown: TR }, { title: "t", description: "d", markdown: EN }, cfg).passed, false);
assert.equal(metaGate({ title: "t", description: "", slug: "ok", markdown: TR }, { title: "t", description: "d", markdown: EN }, cfg).passed, false, "an empty description");
for (const slug of ["Bad Slug", "ļoti", "a--b", "-a", ""]) assert.equal(metaGate({ title: "t", description: "d", slug, markdown: TR }, { title: "t", description: "d", markdown: EN }, cfg).passed, false, `slug ${slug}`);
assert.equal(faqGate(EN, TR).passed, true);
assert.equal(faqGate(EN, TR.replace("Vai tas ir lēti?", "Vai tas ir lēti")).passed, false, "a question without a question mark");
assert.equal(faqGate(EN, TR.replace("Tas ir pietiekami ātri, lai komanda redzētu rezultātu nedēļas laikā.", "Jā.")).passed, false, "a short answer");
assert.equal(faqGate(EN, TR.replace(/### Vai tas ir ātri\?\n\n.*\n\n/, "")).passed, false, "a question dropped");
assert.equal(faqGate("## Part\n\ntext", "## Daļa\n\nteksts").passed, true, "no FAQ in the English text");
const lv = { locale: "lv", name: "Latvian", glossary: [], styleGuide: "", formalAddress: { forbidden: ["tu", "tev", "tavs"] } };
assert.equal(formalAddressGate("Jūs varat to darīt.", lv).passed, true);
assert.equal(formalAddressGate("Vai Tu to vari? Tev ir izvēle.", lv).passed, false, "informal forms are caught, case-insensitively");
assert.equal(formalAddressGate("tulkojums tevišķi", lv).passed, true, "whole words only");
{
  const all = translationChecks({ en: { title: "T", description: "D", markdown: EN }, tr: { title: "Virsraksts", description: "Apraksts", slug: "virsraksts", markdown: TR }, locale: lv, profile: "markdown", gates: cfg, voice: ENGINE_CONFIG.voice });
  assert.deepEqual(gateBlockers(all), []);
  assert.equal(all.filter(failing).length, 0);
  const banned = translationChecks({ en: { title: "T", description: "D", markdown: EN }, tr: { title: "Virsraksts", description: "Apraksts", slug: "virsraksts", markdown: TR.replace("Vēl viens.", "Slepenais vārds šeit.") }, locale: lv, profile: "markdown", gates: cfg, voice: { ...ENGINE_CONFIG.voice, bannedWords: ["slepenais"] } });
  assert.ok(gateBlockers(banned).some((b) => b.gate === "voice"), "the site's banned words apply to the translation");
  const warned = translationChecks({ en: { title: "T", description: "D", markdown: EN }, tr: { title: "Virsraksts", description: "Apraksts", slug: "virsraksts", markdown: `${TR}\n\nSkatiet [a](/blog/other) un atjaunināt jāatjaunina dokumenti.` }, locale: lv, profile: "markdown", gates: cfg, voice: ENGINE_CONFIG.voice });
  assert.deepEqual(gateBlockers(warned), [], "repeat and link findings are warnings");
  assert.deepEqual(toFindings(warned).map((f) => f.gate).sort(), ["links", "repeat"]);
  assert.ok(toFindings(warned).every((f) => f.severity === "warning"));
}

console.log("localization self-test passed");
