import { describe, expect, test } from "bun:test";
import { renderCitations } from "../citations.js";
import { componentsGate, type ComponentsExpectation } from "../gates/components.js";
import { runCodeGates } from "../gates/index.js";
import { ENGINE_CONFIG } from "../config.js";
import { componentProfile } from "../profile.js";
import { briefStage, type BriefInput } from "../stages/brief/index.js";
import { validateBrief, type Brief } from "../stages/brief/schema.js";
import { componentVars, draftStage, type DraftInput } from "../stages/draft/index.js";
import { fakeCtx } from "../stages/test-helpers.js";
import { componentGuide, serviceCtaTag } from "./guide.js";
import { appendProvenance, provenanceTag } from "./provenance.js";
import { lintArticle } from "./lint.js";

const CTA = serviceCtaTag("save-time", "team-handoffs");
const FAQ = "## Frequently Asked Questions\n\n### Does it work for small teams?\n\nYes. Small teams use it every day to save hours on routine work.";
const good = [
  "Opening paragraph about handoffs.",
  "<key-takeaways>\n\n- One takeaway here\n- Two takeaway here\n- Three takeaway here\n\n</key-takeaways>",
  "## Section\n\nBody text {{c:c1}}.",
  CTA,
  FAQ,
].join("\n\n");
const expected: ComponentsExpectation = { service: "save-time", painPoint: "team-handoffs" };

describe("componentProfile", () => {
  test("lindevo only for a frozen Lindevo destination", () => {
    expect(componentProfile({ settings: { destinationProvider: "lindevo" } })).toBe("lindevo");
    for (const settings of [{ destinationProvider: "wordpress" }, { destinationProvider: null }, {}, null]) {
      expect(componentProfile({ settings })).toBe("markdown");
    }
  });
});

describe("components gate", () => {
  test("good Lindevo markdown passes, also after citation rendering with a Sources list and provenance", () => {
    expect(componentsGate(good.replace(" {{c:c1}}", ""), expected).issues).toEqual([]);
    const evidence = [{ id: "c1", claim: "c", quote: "q", sourceId: "s1", verified: true }];
    const sources = [{ id: "s1", url: "https://a.example/p", finalUrl: "https://a.example/p", title: "A", markdown: "" }];
    const rendered = renderCitations(good, evidence, sources, "references", "en");
    expect(rendered).toContain("## Sources");
    const delivered = appendProvenance(rendered, provenanceTag({ sources: 1, checks: 9, reviewed: "2026-11-05", models: ["Claude Sonnet 5.5"] }));
    expect(lintArticle({ en: delivered }).issues).toEqual([]);
    expect(componentsGate(delivered, expected).issues).toEqual([]);
  });

  test("lint errors become blockers naming the rule and line", () => {
    const r = componentsGate(good.replace("</key-takeaways>", ""), expected);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => /^line \d+: unclosed-tag/.test(i.message))).toBe(true);
  });

  test("structure checks: takeaways, the chosen CTA, CTA before the FAQ", () => {
    const msgs = (md: string, e = expected) => componentsGate(md, e).issues.map((i) => i.message).join("\n");
    expect(msgs(good.replace(/<key-takeaways>[\s\S]*<\/key-takeaways>\n\n/, ""))).toContain("expected one <key-takeaways>");
    expect(msgs(good.replace(CTA, ""))).toContain("expected exactly one <service-cta>, found 0");
    expect(msgs(good.replace("save-time", "research"))).toContain('service="research" but the brief chose "save-time"');
    expect(msgs(good.replace(' anchor="team-handoffs"', ""))).toContain("anchor");
    expect(msgs(good.replace(`${CTA}\n\n${FAQ}`, `${FAQ}\n\n${CTA}`))).toContain("before the FAQ");
    expect(msgs(good, { service: null, painPoint: null })).toContain("must not contain a <service-cta>");
  });

  test("runs only when GateInput.components is set, right after structure", async () => {
    const base = { description: "d", evidence: [], existingPosts: [], markdown: good, raw: good, siteUrl: "https://s.example", sources: [], title: "t" };
    const deps = { config: ENGINE_CONFIG, checkLink: async () => 200 };
    const names = async (components?: typeof expected) => (await runCodeGates({ ...base, ...(components ? { components } : {}) }, deps)).map((r) => r.gate);
    expect(await names()).not.toContain("components");
    expect((await names(expected)).slice(0, 2)).toEqual(["structure", "components"]);
  });
});

describe("provenance", () => {
  test("builds an escaped tag and appends it last", () => {
    const tag = provenanceTag({ sources: 2, checks: 8, reviewed: "2026-11-05", models: ['A "B"', "C"] });
    expect(tag).toBe('<provenance sources="2" checks="8" reviewed="2026-11-05" models="A &quot;B&quot;, C"></provenance>');
    expect(appendProvenance("Text\n\n## Sources\n\n1. x\n", tag)).toBe(`Text\n\n## Sources\n\n1. x\n\n${tag}\n`);
    expect(provenanceTag({ sources: 0, checks: 0, reviewed: "2026-11-05", models: [] })).not.toContain("models=");
  });
});

describe("brief service and pain point", () => {
  const brief = (over: Partial<Brief> = {}): Brief => ({
    angle: "A practical look at what handoffs cost a small team",
    primaryKeyword: "team handoffs",
    titleOptions: ["Team handoffs explained", "b title ok", "c title ok"],
    chosenTitle: "Team handoffs explained",
    description: "Learn how handoffs go wrong and how to fix them.",
    outline: Array.from({ length: 5 }, (_, i) => ({ heading: `Section ${i + 1}`, purpose: "Explain this part of the topic", claimIds: [["c1", "c2", "c3"][i % 3]!], words: 320 })),
    faq: [1, 2, 3].map((i) => ({ question: `Question number ${i}?`, answerPoints: ["point"] })),
    takeaways: ["One plain takeaway sentence.", "Two plain takeaway sentence.", "Three plain takeaway sentence."],
    internalLinks: [],
    ...over,
  });
  const ctx = { verifiedIds: new Set(["c1", "c2", "c3"]), links: new Set<string>(), minClaims: 3 };

  test("required in the Lindevo profile, optional otherwise, takeaways capped at 5", () => {
    expect(validateBrief(brief(), ctx)).toEqual([]);
    const issues = validateBrief(brief(), { ...ctx, profile: "lindevo" });
    expect(issues.some((i) => i.startsWith("service is required"))).toBe(true);
    expect(issues.some((i) => i.startsWith("painPoint is required"))).toBe(true);
    expect(validateBrief(brief({ service: "none", painPoint: "none" }), { ...ctx, profile: "lindevo" })).toEqual([]);
    const six = brief({ service: "research", painPoint: "none", takeaways: Array.from({ length: 6 }, (_, i) => `Takeaway sentence number ${i}`) });
    expect(validateBrief(six, { ...ctx, profile: "lindevo" })).toHaveLength(1);
    expect(validateBrief(six, ctx)).toEqual([]);
  });

  test("the CTA tag follows the choice; none writes no CTA", () => {
    expect(serviceCtaTag("research", "none")).toBe('<service-cta service="research"></service-cta>');
    const b = (service: Brief["service"], painPoint: Brief["painPoint"]) => ({ brief: { ...brief({ service, painPoint }), keywordData: null }, profile: "lindevo" as const });
    expect(componentVars(b("research", "team-handoffs")).serviceCta).toContain('<service-cta service="research" anchor="team-handoffs"></service-cta>');
    expect(componentVars(b("none", "none")).serviceCta).toBe("");
    expect(componentVars(b("none", "none")).components).toContain("Do not write a `service-cta`");
  });
});

describe("prompts carry the guide only for the Lindevo profile", () => {
  const briefInput: BriefInput = {
    topic: "team handoffs", locale: "en", sourceType: "article_keyword", voice: "",
    evidence: ["c1", "c2", "c3"].map((id) => ({ id, claim: `claim ${id} here`, quote: "q", url: `https://a.example/${id}` })),
    links: [], keywordData: false, minClaims: 3,
  };
  const reply = (extra: object) => ({
    angle: "A practical look at what handoffs cost a small team",
    primaryKeyword: "team handoffs",
    titleOptions: ["Team handoffs explained", "b title ok", "c title ok"],
    chosenTitle: "Team handoffs explained",
    description: "Learn how handoffs go wrong and how to fix them.",
    outline: Array.from({ length: 5 }, (_, i) => ({ heading: `Section ${i + 1}`, purpose: "Explain this part of the topic", claimIds: [["c1", "c2", "c3"][i % 3]!], words: 320 })),
    faq: [1, 2, 3].map((i) => ({ question: `Question number ${i}?`, answerPoints: ["point"] })),
    takeaways: ["One plain takeaway sentence.", "Two plain takeaway sentence.", "Three plain takeaway sentence."],
    internalLinks: [], ...extra,
  });

  test("brief", async () => {
    const lindevo = fakeCtx({ llm: { brief: [reply({ service: "research", painPoint: "none" })] } });
    const out = await briefStage.run({ ...briefInput, profile: "lindevo" }, lindevo.ctx);
    expect(lindevo.llm.calls[0]?.system).toContain("### <key-takeaways>");
    expect(lindevo.llm.calls[0]?.system).not.toContain("### <service-cta>");
    expect(out.output.service).toBe("research");
    const plain = fakeCtx({ llm: { brief: [reply({})] } });
    await briefStage.run(briefInput, plain.ctx);
    expect(plain.llm.calls[0]?.system).toContain("Plain Markdown only");
    expect(plain.llm.calls[0]?.system).not.toContain("key-takeaways");
    // A Lindevo brief without a service is sent back once, then accepted.
    const repair = fakeCtx({ llm: { brief: [reply({}), reply({ service: "none", painPoint: "none" })] } });
    await briefStage.run({ ...briefInput, profile: "lindevo" }, repair.ctx);
    expect(repair.llm.calls[1]?.user).toContain("service is required");
  });

  test("draft", async () => {
    const input: DraftInput = {
      locale: "en", voice: "",
      brief: { ...reply({ service: "save-time", painPoint: "team-handoffs" }), keywordData: null } as DraftInput["brief"],
      evidence: [{ id: "c1", claim: "claim one", quote: "q", url: "https://a.example/1" }],
      sources: [{ id: "s1", url: "https://a.example/1", finalUrl: "https://a.example/1", title: "One" }],
      evidenceSources: { c1: "s1" }, citationStyle: "references",
    };
    const markdown = `Opening {{c:c1}}.\n\n${"Plain filler sentence for the draft body. ".repeat(60)}`;
    const draft = { title: "t title", description: "A description that is long enough.", markdown, citedClaimIds: ["c1"] };
    const lindevo = fakeCtx({ llm: { draft: [draft] } });
    await draftStage.run({ ...input, profile: "lindevo" }, lindevo.ctx);
    expect(lindevo.llm.calls[0]?.system).toContain("### <key-takeaways>");
    expect(lindevo.llm.calls[0]?.system).toContain('<service-cta service="save-time" anchor="team-handoffs"></service-cta>');
    const plain = fakeCtx({ llm: { draft: [draft] } });
    await draftStage.run(input, plain.ctx);
    expect(plain.llm.calls[0]?.system).toContain("Plain Markdown only");
    expect(plain.llm.calls[0]?.system).not.toContain("service-cta");
  });

  test("the guide documents the engine tag set from the spec", () => {
    const g = componentGuide();
    for (const tag of ["key-takeaways", "workflow", "workflow-step", "service-cta", "callout", "steps", "step"]) expect(g).toContain(`### <${tag}>`);
    expect(g).not.toContain("### <provenance>");
  });
});
