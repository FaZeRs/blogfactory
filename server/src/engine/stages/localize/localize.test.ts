import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createFakeLlm } from "../../adapters/fake-llm.js";
import type { EngineLlm } from "../../adapters/llm.js";
import { dbTestsEnabled } from "../test-db.js";

const enabled = dbTestsEnabled("localize test");
const t = enabled ? await import("../test-db.js") : null;
const { db } = enabled ? await import("../../../db/index.js") : { db: null as never };
const schema = enabled ? await import("../../../db/schema.js") : ({} as never);
const { localizeArticle } = await import("../../../services/localization/localize.js");
const { saveLocalization } = await import("../../../services/localization/settings.js");
const { beginTranslation, runTranslation, translatePost, RUNNING_STALE_MS } = await import("../../../services/localization/translate-post.js");
const { updatePostWithRevision, currentPostRevision } = await import("../../../services/post-revisions.js");

const EN = [
  "Intro paragraph with a claim.[¹](https://s1.example/a) Another one.[²](https://s2.example/b) We support teams with human review every day.",
  "## First part",
  "- one\n- two\n- three",
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
const TR_MD = [
  "Ievads ar apgalvojumu.[¹](https://s1.example/a) Vēl viens.[²](https://s2.example/b) Mēs atbalstām komandas ar cilvēka pārbaude katru dienu.",
  "## Pirmā daļa",
  "- viens\n- divi\n- trīs",
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

const tr = (over: Record<string, unknown> = {}) => ({ title: "Saules enerģija mazām komandām", slug: "saules-energija-mazam-komandam", description: "Praktisks ceļvedis.", markdown: TR_MD, imageAlt: "", ...over });
const CLEAN = { fluency: 9, issues: [] };
const LV = { locale: "lv", name: "Latvian", glossary: [{ source: "human review", target: "cilvēka pārbaude" }], styleGuide: "Formal Jūs.", formalAddress: { forbidden: ["tu", "tev"] } };
const SOURCE = { title: "Solar for small teams", description: "A practical guide.", markdown: EN, imageAlt: "Panels on a roof", keyword: "solar for small teams" };

/** A fake model for the two localization roles; every call costs $0.01 so spend can be checked. */
function fake(replies: { localize?: unknown[]; localize_review?: unknown[] }) {
  const base = createFakeLlm({ localize: [], localize_review: [], ...replies });
  const llm: EngineLlm = { json: async (req) => ({ ...(await base.json(req)), costUsd: 0.01 }) };
  const calls = (role: string) => base.calls.filter((c) => c.role === role);
  return { llm, base, calls };
}
const deps = (llm: EngineLlm) => ({ llm, dataForSeo: null, models: { localize: "m-write", review: "m-review" }, profile: "markdown" as const, origin: "system" as const, logSpend: true });

describe.skipIf(!enabled)("localizeArticle", () => {
  afterAll(() => t!.cleanup());
  const args = async (llm: EngineLlm, extra: Record<string, unknown> = {}) => {
    const { user, site } = await t!.fixture("normal");
    return { userId: user.id, siteId: site.id, locale: LV, source: SOURCE, deps: deps(llm), ...extra };
  };

  test("a clean translation is ready after one translate and one review; spend and one sanitized event are recorded", async () => {
    const f = fake({ localize: [tr()], localize_review: [CLEAN] });
    const a = await args(f.llm);
    const r = await localizeArticle(a);
    expect(r.status).toBe("ready");
    expect(r.translation.slug).toBe("saules-energija-mazam-komandam");
    expect(r.translation.content).toContain("## Avoti");
    expect(r.findings.filter((x) => x.severity === "blocker")).toEqual([]);
    expect(f.calls("localize")).toHaveLength(1);
    expect(f.calls("localize_review")).toHaveLength(1);
    expect(f.calls("localize")[0]!.model).toBe("m-write");
    expect(f.calls("localize_review")[0]!.model).toBe("m-review");
    expect(r.costUsd).toBeCloseTo(0.02);
    const events = await db.select().from(schema.operationEvents).where(and(eq(schema.operationEvents.userId, a.userId), eq(schema.operationEvents.action, "posts.localize")));
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("succeeded");
    expect(Object.keys(events[0]!.metadata as object).sort()).toEqual(["blockers", "cost_usd", "locale", "mode", "patched", "revisions", "status", "warnings"]);
    expect(JSON.stringify(events[0])).not.toContain("Ievads");
    const logs = await db.select().from(schema.generationLogs).where(eq(schema.generationLogs.userId, a.userId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.cost).toBeCloseTo(0.02);
  });

  test("a reviewer's exact fix is applied in code and re-checked, not counted as a revision", async () => {
    const fix = { excerpt: "ar cilvēka pārbaude katru", field: "markdown", fix: "ar cilvēka pārbaudi katru", problem: "wrong case", severity: "major" };
    const f = fake({ localize: [tr()], localize_review: [{ fluency: 6, issues: [fix] }, CLEAN] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("ready");
    expect(r.revisions).toBe(0);
    expect(r.patched).toBe(1);
    expect(r.translation.content).toContain("ar cilvēka pārbaudi katru");
    expect(f.calls("localize")).toHaveLength(1);
    expect(f.calls("localize_review")).toHaveLength(2);
  });

  test("a failed check leads to a revision that edits the failed attempt with the blockers as feedback", async () => {
    const broken = tr({ title: "Pirmais mēģinājums", markdown: TR_MD.replace("- viens\n- divi\n- trīs", "- viens\n- divi") });
    const f = fake({ localize: [broken, tr({ title: "Labotais variants" })], localize_review: [CLEAN, CLEAN] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("ready");
    expect(r.revisions).toBe(1);
    expect(r.translation.title).toBe("Labotais variants");
    const second = f.calls("localize")[1]!.user;
    expect(second).toContain("Pirmais mēģinājums");
    expect(second).toContain("list items");
    expect(f.calls("localize")[0]!.user).toContain("None. This is the first attempt.");
  });

  test("the last passing attempt is kept when later polishing fails", async () => {
    const minor = { fluency: 7, issues: [{ excerpt: "teksts kura nav", field: "markdown", fix: "kaut kas cits", problem: "unnatural", severity: "minor" }] };
    const informal = (title: string) => tr({ title, markdown: TR_MD.replace("Vēl viens.", "Vai tu to vari?") });
    const f = fake({ localize: [tr({ title: "Pirmais" }), informal("Otrais"), informal("Trešais")], localize_review: [minor, CLEAN, CLEAN] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("ready");
    expect(r.translation.title).toBe("Pirmais");
    expect(r.revisions).toBe(2);
    expect(f.calls("localize")).toHaveLength(3);
  });

  test("a text that never passes comes back needs_review with its findings, after two revisions at most", async () => {
    const informal = (title: string) => tr({ title, markdown: TR_MD.replace("Vēl viens.", "Vai tu to vari?") });
    const f = fake({ localize: [informal("Attempt one"), informal("Attempt two"), informal("Attempt three")], localize_review: [CLEAN, CLEAN, CLEAN] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("needs_review");
    expect(r.revisions).toBe(2);
    expect(r.translation.title).toBe("Attempt three");
    expect(r.findings.some((x) => x.gate === "formal-address" && x.severity === "blocker")).toBe(true);
    expect(f.calls("localize")).toHaveLength(3);
  });

  test("a revision that fails keeps the translation that already exists", async () => {
    const broken = tr({ title: "Pirmais mēģinājums", markdown: TR_MD.replace("- viens\n- divi\n- trīs", "- viens\n- divi") });
    const f = fake({ localize: [broken], localize_review: [CLEAN] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("needs_review");
    expect(r.translation.title).toBe("Pirmais mēģinājums");
    expect(r.findings.some((x) => x.gate === "revision")).toBe(true);
  });

  test("a review that cannot run is a blocker, not a lost translation", async () => {
    const f = fake({ localize: [tr(), tr(), tr()], localize_review: [] });
    const r = await localizeArticle(await args(f.llm));
    expect(r.status).toBe("needs_review");
    expect(r.findings.some((x) => x.gate === "review")).toBe(true);
    expect(r.translation.content).toContain("## Avoti");
  });

  test("update mode starts from the existing translation, lists what changed, and keeps edited wording out of minor polish", async () => {
    const minor = { fluency: 8, issues: [{ excerpt: "Vēl viens", field: "markdown", fix: "Vēl cits", problem: "unnatural", severity: "minor" }] };
    const f = fake({ localize: [tr()], localize_review: [minor] });
    const base = { title: "Mans virsraksts", slug: "mans-virsraksts", description: "Mans apraksts.", content: TR_MD, imageAlt: "", edited: true };
    const r = await localizeArticle(await args(f.llm, { base, changes: "+ added or reworded (new): something" }));
    const user = f.calls("localize")[0]!.user;
    expect(user).toContain("Mans virsraksts");
    expect(user).toContain("something");
    expect(r.status).toBe("ready");
    expect(r.patched).toBe(0);
    expect(r.revisions).toBe(0);
    expect(r.translation.content).toContain("Vēl viens.");
    expect(f.calls("localize")).toHaveLength(1);
    // The same minor finding on a translation that was not edited by hand is polished.
    const g = fake({ localize: [tr()], localize_review: [minor, CLEAN] });
    const polished = await localizeArticle(await args(g.llm, { base: { ...base, edited: false } }));
    expect(polished.patched).toBe(1);
    expect(polished.translation.content).toContain("Vēl cits.");
  });

  test("a locale the site has not enabled is refused", async () => {
    const f = fake({});
    const a = await args(f.llm, { locale: "lv" });
    await expect(localizeArticle(a)).rejects.toThrow("not enabled");
  });

  test("the budget cap stops new model calls and keeps what exists", async () => {
    const informal = tr({ markdown: TR_MD.replace("Vēl viens.", "Vai tu to vari?") });
    const f = fake({ localize: [informal, informal, informal], localize_review: [CLEAN, CLEAN, CLEAN] });
    const a = await args(f.llm);
    const r = await localizeArticle({ ...a, deps: { ...a.deps, maxCostUsd: 0.015 } });
    expect(r.status).toBe("needs_review");
    expect(f.calls("localize")).toHaveLength(1);
  });
});

describe.skipIf(!enabled)("the localize stage", () => {
  afterAll(() => t!.cleanup());

  async function setup(localization: unknown) {
    const fx = await t!.fixture("normal");
    if (localization) await saveLocalization(fx.user.id, fx.site.id, localization);
    return fx;
  }
  /** The translation role echoes the article it is given (so the structure always matches); the review role replays `reviews`. */
  const withLocalizer = (base: { llm: EngineLlm }, opts: { reviews: unknown[]; mutate?: (md: string) => string; failLocalize?: boolean }) => {
    const review = createFakeLlm({ localize_review: opts.reviews });
    let translations = 0;
    const llm: EngineLlm = {
      json: async (req) => {
        if (req.role === "localize") {
          translations += 1;
          if (opts.failLocalize) throw new Error("model down");
          const md = /<data-[a-f0-9]+ label="article">\n([\s\S]*?)\n<\/data-/.exec(req.user)![1]!.replace("## Sources", "## Avoti");
          const value = req.schema.parse(tr({ markdown: opts.mutate ? opts.mutate(md) : md }));
          return { value, model: req.model, promptTokens: 0, completionTokens: 0, costUsd: 0 };
        }
        return req.role === "localize_review" ? review.json(req) : base.llm.json(req);
      },
    };
    return { llm, translations: () => translations };
  };
  const rows = (postId: string) => db.select().from(schema.postTranslations).where(eq(schema.postTranslations.postId, postId));
  const stageNames = async (runId: string) => (await db.select().from(schema.articleStageRuns).where(eq(schema.articleStageRuns.runId, runId))).map((r: { stage: string }) => r.stage);

  test("a site with localization on translates after the checks and deliver stores the translation against the first revision", async () => {
    const { run, user } = await setup({ enabled: true, locales: [LV] });
    const made = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const localizer = withLocalizer(made.deps, { reviews: [{ candidates: ["saules paneļi mazām komandām"] }, CLEAN] });
    const end = await t!.drive(run.id, { ...made.deps, llm: localizer.llm });
    expect(end.state).toBe("done");
    expect(await stageNames(run.id)).toContain("localize");
    const [row] = await rows(end.postId!);
    expect(row!.locale).toBe("lv");
    expect(row!.userId).toBe(user.id);
    expect(row!.keyword).toBe("saules paneļi mazām komandām");
    expect(row!.status).toBe("ready");
    expect(row!.content).toContain("## Avoti");
    const revision = await currentPostRevision(user.id, end.postId!);
    expect(row!.sourceRevisionId).toBe(revision!.id);
    expect(made.keywordCalls.n).toBeGreaterThan(0);
    expect(localizer.translations()).toBe(1);
  });

  test("a translation that cannot be made never fails the run: the English draft still delivers", async () => {
    const { run } = await setup({ enabled: true, locales: [LV] });
    const made = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const localizer = withLocalizer(made.deps, { reviews: [], failLocalize: true });
    const end = await t!.drive(run.id, { ...made.deps, llm: localizer.llm });
    expect(end.state).toBe("done");
    expect(end.postId).not.toBeNull();
    expect(await rows(end.postId!)).toHaveLength(0);
    const [stage] = (await db.select().from(schema.articleStageRuns).where(and(eq(schema.articleStageRuns.runId, run.id), eq(schema.articleStageRuns.stage, "localize")))) as { output: { output: { locales: { status: string; error: string }[] } } }[];
    expect(stage!.output.output.locales[0]!.status).toBe("failed");
    expect(stage!.output.output.locales[0]!.error).toContain("model down");
  });

  test("a translation that fails its checks is stored needs_review, and the English still delivers", async () => {
    const { run } = await setup({ enabled: true, locales: [LV] });
    const made = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const localizer = withLocalizer(made.deps, { reviews: [{ candidates: ["x kandidāts"] }, CLEAN, CLEAN, CLEAN], mutate: (md) => `Vai tu to vari? ${md}` });
    const end = await t!.drive(run.id, { ...made.deps, llm: localizer.llm });
    expect(end.state).toBe("done");
    const [row] = await rows(end.postId!);
    expect(row!.status).toBe("needs_review");
    expect((row!.findings as { severity: string }[]).some((f) => f.severity === "blocker")).toBe(true);
  });

  test("a site without localization goes straight from the checks to deliver", async () => {
    const { run } = await setup(null);
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("done");
    expect(await stageNames(run.id)).not.toContain("localize");
    expect(await rows(end.postId!)).toHaveLength(0);
  });

  test("localization turned on but with no locale also skips the stage", async () => {
    const { run } = await setup({ enabled: true, locales: [] });
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(run.id, deps);
    expect(await stageNames(run.id)).not.toContain("localize");
    expect(end.state).toBe("done");
  });
});

describe.skipIf(!enabled)("translatePost", () => {
  afterAll(() => t!.cleanup());

  async function post(localization: unknown = { enabled: true, locales: [LV] }) {
    const fx = await t!.fixture("normal");
    if (localization) await saveLocalization(fx.user.id, fx.site.id, localization);
    const [p] = await db.insert(schema.posts).values({
      userId: fx.user.id, siteId: fx.site.id, title: "Solar for small teams", content: EN, summary: "A practical guide.", status: "draft", sourceType: "article_keyword", modelId: "m",
    }).returning();
    return { ...fx, post: p! };
  }
  const row = async (postId: string) => (await db.select().from(schema.postTranslations).where(eq(schema.postTranslations.postId, postId)))[0];

  test("creates a ready translation tied to the current revision; it goes stale when the English changes", async () => {
    const { user, post: p } = await post();
    const f = fake({ localize: [tr()], localize_review: [CLEAN] });
    const r = await translatePost(user.id, p.id, "lv", { deps: deps(f.llm) });
    expect(r.status).toBe("ready");
    const saved = (await row(p.id))!;
    expect(saved.status).toBe("ready");
    expect(saved.siteId).toBe(p.siteId!);
    expect(saved.title).toBe("Saules enerģija mazām komandām");
    expect(saved.costUsd).toBeCloseTo(0.02);
    const rev = await currentPostRevision(user.id, p.id);
    expect(saved.sourceRevisionId).toBe(rev!.id);
    await updatePostWithRevision({ userId: user.id, postId: p.id, expectedUpdatedAt: p.updatedAt, source: "save", changes: { content: `${EN}\n\nA new paragraph.` } });
    const after = await currentPostRevision(user.id, p.id);
    expect(after!.id).not.toBe(saved.sourceRevisionId);
  });

  test("an existing translation is updated: it is the base, the English change is listed, and a hand-edited row stays edited until re-made", async () => {
    const { user, post: p } = await post();
    const first = fake({ localize: [tr()], localize_review: [CLEAN] });
    await translatePost(user.id, p.id, "lv", { deps: deps(first.llm) });
    await db.update(schema.postTranslations).set({ status: "edited", title: "Rediģēts virsraksts" }).where(eq(schema.postTranslations.postId, p.id));
    const fresh = await db.select().from(schema.posts).where(eq(schema.posts.id, p.id));
    await updatePostWithRevision({ userId: user.id, postId: p.id, expectedUpdatedAt: fresh[0]!.updatedAt, source: "save", changes: { content: EN.replace("Another one.", "Brand new sentence.") } });
    const second = fake({ localize: [tr({ title: "Rediģēts virsraksts" })], localize_review: [CLEAN] });
    await translatePost(user.id, p.id, "lv", { deps: deps(second.llm) });
    const user1 = second.calls("localize")[0]!.user;
    expect(user1).toContain("Rediģēts virsraksts");
    expect(user1).toContain("Brand new sentence.");
    const saved = (await row(p.id))!;
    expect(saved.status).toBe("ready");
    expect(saved.costUsd).toBeCloseTo(0.04);
    const rev = await currentPostRevision(user.id, p.id);
    expect(saved.sourceRevisionId).toBe(rev!.id);
  });

  test("only one translation per post and locale runs at once; a dead run's claim can be taken over", async () => {
    const { user, post: p } = await post();
    const claim = await beginTranslation(user.id, p.id, "lv");
    await expect(beginTranslation(user.id, p.id, "lv")).rejects.toMatchObject({ status: 409 });
    expect((await row(p.id))!.status).toBe("running");
    const later = new Date(Date.now() + RUNNING_STALE_MS + 1000);
    const takeover = await beginTranslation(user.id, p.id, "lv", later);
    expect(takeover.prior!.status).toBe("needs_review");
    // The first run ending after its claim was taken still releases cleanly.
    const f = fake({ localize: [tr()], localize_review: [CLEAN] });
    await runTranslation(takeover, { deps: deps(f.llm) });
    expect((await row(p.id))!.status).toBe("ready");
    void claim;
  });

  test("a failed run removes a new row and restores an old one", async () => {
    const { user, post: p } = await post();
    const none = fake({ localize: [], localize_review: [] });
    await expect(translatePost(user.id, p.id, "lv", { deps: deps(none.llm) })).rejects.toThrow();
    expect(await row(p.id)).toBeUndefined();
    const ok = fake({ localize: [tr()], localize_review: [CLEAN] });
    await translatePost(user.id, p.id, "lv", { deps: deps(ok.llm) });
    const before = (await row(p.id))!;
    await expect(translatePost(user.id, p.id, "lv", { deps: deps(none.llm) })).rejects.toThrow();
    const after = (await row(p.id))!;
    expect(after.status).toBe("ready");
    expect(after.title).toBe(before.title);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test("tenant scope: another user's post is not found, and a locale the site has not enabled is refused", async () => {
    const { post: p } = await post();
    const other = await t!.fixture("normal");
    await expect(beginTranslation(other.user.id, p.id, "lv")).rejects.toMatchObject({ status: 404 });
    expect(await row(p.id)).toBeUndefined();
    const { user, post: q } = await post();
    await expect(beginTranslation(user.id, q.id, "de")).rejects.toMatchObject({ status: 400 });
    const off = await post({ enabled: false, locales: [LV] });
    await expect(beginTranslation(off.user.id, off.post.id, "lv")).rejects.toMatchObject({ status: 400 });
  });
});
