import { afterAll, describe, expect, test } from "bun:test";
import { createFakeLlm } from "../adapters/fake-llm.js";
import { loadEvalBriefs } from "../evals/schema.js";
import { dbTestsEnabled } from "./test-db.js";

const enabled = dbTestsEnabled("learning engine test");
const t = await (enabled ? import("./test-db.js") : Promise.resolve(null));
const { db } = enabled ? await import("../../db/index.js") : { db: null as never };
const { styleRules } = enabled ? await import("../../db/schema.js") : ({} as never);
const { eq } = await import("drizzle-orm");
const rules = enabled ? await import("../../services/learning/rules.js") : (null as never);
const { runRuleEval } = enabled ? await import("../../services/learning/eval-check.js") : ({} as never);
const { localizeArticle } = enabled ? await import("../../services/localization/localize.js") : ({} as never);

const RULE_DRAFT = "Write 'use', never 'utilize'.";
const RULE_LV = "Use sentence case in every Latvian heading.";
const RULE_PROPOSED = "Never open with a rhetorical question.";
const RULE_OTHER = "Another account's rule about semicolons.";

const add = (userId: string, siteId: string, scope: string, rule: string, status = "approved") =>
  db.insert(styleRules).values({ userId, siteId, scope, rule, status, decidedAt: new Date() });

describe.skipIf(!enabled)("learned style rules in prompts", () => {
  afterAll(() => t!.cleanup());

  test("an approved draft rule reaches the brief, draft and revise prompts; other scopes, proposals and other accounts do not", async () => {
    const { run, user, site } = await t!.fixture("normal");
    const other = await t!.fixture("normal");
    await add(user.id, site.id, "draft", RULE_DRAFT);
    await add(user.id, site.id, "translation:lv", RULE_LV);
    await add(user.id, site.id, "draft", RULE_PROPOSED, "proposed");
    await add(other.user.id, other.site.id, "draft", RULE_OTHER);
    const { deps, llm } = t!.makeDeps({ drafts: [t!.SHORT_ARTICLE], revisions: [t!.GOOD_ARTICLE] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("done");
    for (const role of ["brief", "draft", "revise"]) {
      const call = llm.calls.find((c) => c.role === role)!;
      expect(call.system).toContain("## Learned style rules");
      expect(call.system).toContain(`- ${RULE_DRAFT}`);
      expect(call.system).toContain("guidance on wording only");
      for (const absent of [RULE_LV, RULE_PROPOSED, RULE_OTHER]) expect(call.system).not.toContain(absent);
    }
  });

  test("with no rules the block says None yet.", async () => {
    const { run } = await t!.fixture("normal");
    const { deps, llm } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    await t!.drive(run.id, deps);
    expect(llm.calls.find((c) => c.role === "draft")!.system).toContain("## Learned style rules\nNone yet.");
  });

  test("the text collapses whitespace, caps each rule at 300 characters and keeps the newest 30", async () => {
    const { user, site } = await t!.fixture("normal");
    await add(user.id, site.id, "draft", `spaced   out\n\nrule ${"x".repeat(400)}`);
    for (let i = 0; i < 31; i += 1) await db.insert(styleRules).values({ userId: user.id, siteId: site.id, scope: "draft", rule: `rule number ${i}`, status: "approved", decidedAt: new Date(Date.now() + (i + 1) * 1000) });
    const text = await rules.styleRulesText(user.id, site.id, "draft");
    expect(text).toContain("- rule number 30");
    expect(text).toContain("- rule number 1\n");
    expect(text).not.toContain("spaced"); // the oldest of 32 falls outside the newest 30
    expect(text.split("\n").filter((l: string) => l.startsWith("- "))).toHaveLength(30);
    const only = await t!.fixture("normal");
    await add(only.user.id, only.site.id, "draft", `spaced   out\n\nrule ${"x".repeat(400)}`);
    const capped = (await rules.styleRulesText(only.user.id, only.site.id, "draft")).split("\n").find((l: string) => l.startsWith("- "))!;
    expect(capped.startsWith("- spaced out rule x")).toBe(true);
    expect(capped.length).toBe(2 + 300);
    expect(await rules.styleRulesText(only.user.id, only.site.id, "translation:lv")).toBe("None yet.");
  });

  test("a translation rule reaches the localize prompt for its locale only", async () => {
    const { user, site } = await t!.fixture("normal");
    await add(user.id, site.id, "translation:lv", RULE_LV);
    await add(user.id, site.id, "draft", RULE_DRAFT);
    const prompts: Record<string, string> = {};
    const attempt = async (locale: string) => {
      const llm = { json: async (req: { role: string; system: string }) => { if (req.role === "localize") prompts[locale] = req.system; throw new Error("stop"); } };
      await localizeArticle({
        userId: user.id, siteId: site.id, locale: { locale, name: locale, glossary: [], styleGuide: "" },
        source: { title: "T", description: "D", markdown: "Body", imageAlt: "", keyword: null } as never,
        deps: { llm: llm as never, dataForSeo: null, models: { localize: "m", review: "m" }, profile: "markdown", origin: "web", logSpend: false },
      }).catch(() => {});
    };
    await attempt("lv");
    await attempt("de");
    expect(prompts.lv).toContain(`- ${RULE_LV}`);
    expect(prompts.lv).not.toContain(RULE_DRAFT);
    expect(prompts.de).toContain("None yet.");
    expect(prompts.de).not.toContain(RULE_LV);
  });
});

describe.skipIf(!enabled)("rule eval check", () => {
  const plan = {
    angle: "Most order emails follow a pattern, so a person can keep the final say",
    primaryKeyword: "order email automation",
    titleOptions: ["Order emails into spreadsheet rows", "Trusting rows built from emails", "Checking order rows by hand"],
    chosenTitle: "Order emails into spreadsheet rows",
    description: "How a small team turns order emails into spreadsheet rows.",
    outline: Array.from({ length: 5 }, (_, i) => ({ heading: `Section ${i + 1}`, purpose: "Explain this part of the topic", claimIds: [["c1", "c2", "c3"][i % 3]!], words: 320 })),
    faq: [1, 2, 3].map((i) => ({ question: `Question number ${i}?`, answerPoints: ["point"] })),
    takeaways: ["One plain takeaway sentence.", "Two plain takeaway sentence.", "Three plain takeaway sentence."],
    internalLinks: [],
  };
  const written = { title: "Ignored", description: "A description that is long enough.", markdown: `Opening paragraph {{c:c1}}.\n\n## First\n\n${"Plain filler sentence for the draft body. ".repeat(60)}\n\nAnother claim {{c:c2}}.`, citedClaimIds: ["c1", "c2"] };
  const good = { accuracy: 8, clarity: 8, note: "n", specificity: 8, usefulness: 8, voice: 8 };
  const worse = { ...good, voice: 6 };

  test("runs a brief with and without the rule, judges both, stores the summary and applies nothing", async () => {
    const { user, site } = await t!.fixture("normal");
    const [row] = await db.insert(styleRules).values({ userId: user.id, siteId: site.id, scope: "draft", rule: RULE_DRAFT }).returning();
    // Baseline is judged first (rubric), then the candidate; the pairwise verdict says the candidate wins.
    const llm = createFakeLlm({ brief: [plan, plan], draft: [written, written], revise: Array(8).fill(written), judge: [worse, good, { reason: "r", winner: "A" }] });
    const briefs = (await loadEvalBriefs()).slice(0, 1);
    const result = await runRuleEval({ userId: user.id, ruleId: row!.id, deps: { llm, draftModel: "writer/m", judgeModel: "judge/m", briefs } });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.briefs).toBe(1);
    expect(result.meanDelta).toBeCloseTo(0.4, 3);
    expect(result.dims.voice).toBe(2);
    expect(result.wins + result.losses + result.ties).toBe(1);
    const drafts = llm.calls.filter((c) => c.role === "draft");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.system).not.toContain(RULE_DRAFT);
    expect(drafts[1]!.system).toContain(`- ${RULE_DRAFT}`);
    expect(drafts.every((c) => c.model === "writer/m")).toBe(true);
    expect(llm.calls.filter((c) => (c.role as string) === "judge").every((c) => c.model === "judge/m")).toBe(true);
    const [stored] = await db.select().from(styleRules).where(eq(styleRules.id, row!.id));
    expect(stored!.status).toBe("proposed");
    expect((stored!.eval as { status: string }).status).toBe("done");
  });

  test("a model failure is stored as a failed check", async () => {
    const { user, site } = await t!.fixture("normal");
    const [row] = await db.insert(styleRules).values({ userId: user.id, siteId: site.id, scope: "draft", rule: RULE_DRAFT, status: "proposed" }).returning();
    const llm = createFakeLlm({});
    const result = await runRuleEval({ userId: user.id, ruleId: row!.id, deps: { llm, draftModel: "w", judgeModel: "j", briefs: (await loadEvalBriefs()).slice(0, 1) } });
    expect(result.status).toBe("failed");
  });
});
