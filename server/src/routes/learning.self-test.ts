import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("learning routes self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { postTranslations, posts, sites, styleRules, users, articleRuns, jobs, learningSignals } = await import("../db/schema.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { createLearningRoutes } = await import("./learning.js");
  const { postTranslationsRoutes } = await import("./post-translations.js");
  const { styleRulesText } = await import("../services/learning/rules.js");

  const mk = async () => (await db.insert(users).values({ email: `learning-routes-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const [theirSite] = await db.insert(sites).values({ userId: other.id, name: "T", domain: "t.example.test" }).returning();
    const background: Promise<unknown>[] = [];
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const routes = createLearningRoutes({
      run: (p) => { background.push(p); },
      persistent: () => true,
      hasKey: async () => true,
      distill: (async (input: any) => { await gate; started.push(`distill:${input.siteId}`); return { signals: 0, proposals: 0, costUsd: 0 }; }) as never,
      evalRule: (async (input: any) => { started.push(`eval:${input.ruleId}`); return { status: "done" }; }) as never,
    });
    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", routes).onError(handleApiError);
    const req = (method: string, path: string, body?: unknown, userId = owner.id) =>
      app(userId).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = async (res: Response) => res.json() as Promise<any>;
    const rule = (extra: Record<string, unknown> = {}) => db.insert(styleRules).values({ userId: owner.id, siteId: site.id, scope: "draft", rule: "Write 'use', not 'utilize'.", rationale: "seen twice", evidence: [{ signalId: "x", kind: "comment", locale: null, excerpt: "e" }], ...extra }).returning().then((r) => r[0]!);
    const proposed = await rule();

    // tenant scope: another user's site or rule is 404 on every route
    for (const [m, p, b] of [
      ["GET", `/rules?siteId=${site.id}`, undefined], ["POST", `/rules/${proposed.id}/approve`, {}], ["POST", `/rules/${proposed.id}/reject`, {}], ["POST", `/rules/${proposed.id}/retire`, {}],
      ["POST", `/rules/${proposed.id}/eval`, {}], ["POST", `/distill?siteId=${site.id}`, {}], ["GET", `/settings?siteId=${site.id}`, undefined], ["PUT", `/settings?siteId=${site.id}`, { enabled: true }],
    ] as const) assert.equal((await req(m, p, b, other.id)).status, 404, `${m} ${p}`);
    assert.equal((await req("GET", "/rules")).status, 400);
    assert.equal((await req("GET", `/rules?siteId=${theirSite.id}`)).status, 404);
    assert.equal((await req("POST", "/rules/not-a-uuid/approve", {})).status, 404);
    assert.equal((await req("GET", `/rules?siteId=${site.id}`, undefined, other.id)).status, 404);
    assert.equal((await db.select().from(styleRules).where(eq(styleRules.id, proposed.id)))[0]!.status, "proposed", "nothing changed by the other user");

    // list, grouped by status
    let list = await json(await req("GET", `/rules?siteId=${site.id}`));
    assert.deepEqual(Object.keys(list).sort(), ["approved", "proposed", "rejected", "retired"]);
    assert.deepEqual(list.proposed.map((r: any) => [r.id, r.scope, r.rationale]), [[proposed.id, "draft", "seen twice"]]);

    // nothing applies before approval; approving with an edit stores the owner's text
    assert.equal(await styleRulesText(owner.id, site.id, "draft"), "None yet.");
    assert.equal((await req("POST", `/rules/${proposed.id}/approve`, { rule: "" })).status, 400);
    assert.equal((await req("POST", `/rules/${proposed.id}/approve`, { rule: "x".repeat(201) })).status, 400);
    const ok = await json(await req("POST", `/rules/${proposed.id}/approve`, { rule: "  Write 'use'  instead of 'utilize'. " }));
    assert.deepEqual([ok.rule.status, ok.rule.rule], ["approved", "Write 'use' instead of 'utilize'."]);
    assert.match(await styleRulesText(owner.id, site.id, "draft"), /- Write 'use' instead of 'utilize'\./);
    assert.equal((await req("POST", `/rules/${proposed.id}/approve`, {})).status, 409, "an approved rule cannot be approved again");
    assert.equal((await req("POST", `/rules/${proposed.id}/reject`, {})).status, 409);

    // retire proposal: approving it retires its target
    const retire = await rule({ op: "retire", targetRuleId: proposed.id, rule: proposed.rule });
    list = await json(await req("GET", `/rules?siteId=${site.id}`));
    assert.equal(list.proposed.length, 1);
    assert.equal((await req("POST", `/rules/${retire.id}/approve`, {})).status, 200);
    list = await json(await req("GET", `/rules?siteId=${site.id}`));
    assert.deepEqual([list.approved.length, list.retired.map((r: any) => r.id), list.proposed.length], [0, [proposed.id], 0]);
    assert.equal(await styleRulesText(owner.id, site.id, "draft"), "None yet.", "a retired rule is no longer injected");
    const dangling = await rule({ op: "retire", targetRuleId: proposed.id });
    assert.equal((await req("POST", `/rules/${dangling.id}/approve`, {})).status, 409, "the target is no longer approved");

    // reject and retire
    const toReject = await rule();
    assert.equal((await req("POST", `/rules/${toReject.id}/retire`, {})).status, 409, "only an approved rule is retired");
    assert.equal((await json(await req("POST", `/rules/${toReject.id}/reject`, {}))).rule.status, "rejected");
    const toRetire = await rule({ status: "approved", decidedAt: new Date() });
    assert.equal((await json(await req("POST", `/rules/${toRetire.id}/retire`, {}))).rule.status, "retired");

    // eval: draft rules only, detached, once at a time
    const forEval = await rule();
    const evalRes = await req("POST", `/rules/${forEval.id}/eval`, {});
    assert.equal(evalRes.status, 202);
    assert.equal((await db.select().from(styleRules).where(eq(styleRules.id, forEval.id)))[0]!.eval && ((await db.select().from(styleRules).where(eq(styleRules.id, forEval.id)))[0]!.eval as any).status, "running");
    assert.equal((await req("POST", `/rules/${forEval.id}/eval`, {})).status, 409, "already running");
    const lv = await rule({ scope: "translation:lv" });
    assert.equal((await req("POST", `/rules/${lv.id}/eval`, {})).status, 400, "no translation eval suite");
    await Promise.all(background.splice(0));
    assert.deepEqual(started, [`eval:${forEval.id}`]);
    const noWorker = createLearningRoutes({ persistent: () => false });
    const refused = await new Hono().use("*", async (c, next) => { c.set("userId" as never, owner.id as never); await next(); }).route("/", noWorker).onError(handleApiError)
      .request(`/distill?siteId=${site.id}`, { method: "POST" });
    assert.equal(refused.status, 400);

    // distill: 202, detached, scoped to the site, one at a time
    const d = await req("POST", `/distill?siteId=${site.id}`);
    assert.equal(d.status, 202);
    assert.equal((await req("POST", `/distill?siteId=${site.id}`)).status, 409, "already running");
    release();
    await Promise.all(background.splice(0));
    assert.deepEqual(started.slice(1), [`distill:${site.id}`]);
    assert.equal((await req("POST", `/distill?siteId=${site.id}`)).status, 202, "can start again once it finished");
    await Promise.all(background.splice(0));

    // settings
    assert.deepEqual(await json(await req("GET", `/settings?siteId=${site.id}`)), { enabled: false, lastDistillAt: null, signals: 0 });
    assert.equal((await req("PUT", `/settings?siteId=${site.id}`, { enabled: "yes" })).status, 400);
    assert.deepEqual((await json(await req("PUT", `/settings?siteId=${site.id}`, { enabled: true }))).enabled, true);
    assert.equal((await json(await req("GET", `/settings?siteId=${site.id}`))).enabled, true);
    assert.equal((await json(await req("GET", `/settings?siteId=${theirSite.id}`, undefined, other.id))).enabled, false, "per site and user");

    // the translation save stores a signal against the engine's text; a hand-made translation stores none
    const [post] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "T", content: "Body.\n", sourceType: "article_title", modelId: "m" }).returning();
    const [job] = await db.insert(jobs).values({ userId: owner.id, siteId: site.id, sourceType: "article_keyword", sourceValue: "x", modelId: "m" }).returning();
    await db.insert(articleRuns).values({ userId: owner.id, siteId: site.id, jobId: job.id, postId: post.id, mode: "normal", sourceType: "article_keyword", topic: "x", settings: {}, budgetUsd: 1, state: "done" });
    const [tr] = await db.insert(postTranslations).values({ userId: owner.id, siteId: site.id, postId: post.id, locale: "lv", title: "Nosaukums", slug: "nosaukums", description: "Apraksts", content: "Mēs lietojam rīku.", engineContent: "Mēs lietojam rīku.", status: "ready" }).returning();
    const [hand] = await db.insert(postTranslations).values({ userId: owner.id, siteId: site.id, postId: post.id, locale: "de", title: "Titel", slug: "titel", description: "x", content: "Von Hand.", status: "ready" }).returning();
    const trApp = new Hono().use("*", async (c, next) => { c.set("userId" as never, owner.id as never); await next(); }).route("/", postTranslationsRoutes).onError(handleApiError);
    const put = (locale: string, row: typeof tr, content: string) => trApp.request(`/${post.id}/translations/${locale}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: row.title, slug: row.slug, description: row.description, content, imageAlt: "", expectedUpdatedAt: row.updatedAt.toISOString() }),
    });
    assert.equal((await put("lv", tr, "Mēs izmantojam rīku.")).status, 200);
    assert.equal((await put("de", hand, "Von Hand, geändert.")).status, 200);
    const sigs = await db.select().from(learningSignals).where(eq(learningSignals.postId, post.id));
    assert.deepEqual(sigs.map((s) => [s.kind, s.locale]), [["edit", "lv"]]);
    assert.deepEqual((sigs[0]!.payload as any).hunks.map((h: any) => [h.before, h.after]), [["lietojam", "izmantojam"]]);
    // the ledger: one event per decision, ids only (the generic route-shaped middleware event is not part of the app built here)
    const { operationEvents } = await import("../db/schema.js");
    const { and } = await import("drizzle-orm");
    const ledger = (action: string) => db.select().from(operationEvents).where(and(eq(operationEvents.userId, owner.id), eq(operationEvents.action, action)));
    for (const [action, id, type] of [
      ["learning.rule_approve", proposed.id, "style_rule"], ["learning.rule_approve", retire.id, "style_rule"], ["learning.rule_reject", toReject.id, "style_rule"],
      ["learning.rule_retire", toRetire.id, "style_rule"], ["learning.rule_eval", forEval.id, "style_rule"], ["learning.settings", site.id, "site"],
    ] as const) {
      const events = (await ledger(action)).filter((e) => e.objectId === id);
      assert.equal(events.length, 1, `${action} writes one event`);
      assert.deepEqual([events[0]!.origin, events[0]!.objectType, events[0]!.siteId, events[0]!.status], ["web", type, site.id, "succeeded"]);
    }
    const all = await db.select().from(operationEvents).where(eq(operationEvents.userId, owner.id));
    assert.ok(!/utilize|seen twice|instead of/.test(JSON.stringify(all)), "no rule text, rationale or evidence in the ledger");
    assert.equal((await ledger("learning.rule_reject")).length, 1, "a refused decision (409) writes no event");
    console.log("learning routes self-test ok");
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  process.exit(0);
}
