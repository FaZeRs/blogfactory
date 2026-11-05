import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ideas routes self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { ideas, jobs, operationEvents, sites, users } = await import("../db/schema.js");
  const { createFakeLlm } = await import("../engine/adapters/fake-llm.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { createIdeasRoutes } = await import("./ideas.js");
  const { settingsRoutes } = await import("./settings.js");

  const mk = async () => (await db.insert(users).values({ email: `ideas-routes-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const [theirSite] = await db.insert(sites).values({ userId: other.id, name: "T", domain: "t.example.test" }).returning();
    const startRun = async (input: any) => {
      const [job] = await db.insert(jobs).values({ userId: input.userId, siteId: input.siteId, sourceType: "article_title", sourceValue: input.topic, modelId: "m" }).returning();
      return { jobId: job.id, runId: randomUUID(), estimateUsd: 1 };
    };
    const discoveryDeps = async () => ({
      llm: createFakeLlm({ brief: [{ ideas: [{ title: "ignored", angle: "x", primaryKeyword: "model keyword", alternateKeywords: [], searchIntent: "informational", audienceQuestion: "q",  outline: ["a", "b", "c"], whyNow: "because", informationGain: ["g"], signalIds: [], fit: 8, gain: 6, demandEstimate: 7, rationale: "r" }] }] }),
      model: "test/model", dataForSeo: null, dataForSeoSpent: () => 0, collectors: {},
    }) as never;
    const routes = createIdeasRoutes({ startRun: startRun as never, discoveryDeps });
    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", routes).onError(handleApiError);
    const req = (method: string, path: string, body?: unknown, userId = owner.id) =>
      app(userId).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = async (res: Response) => res.json() as Promise<any>;

    // manual idea: rated by the model call, keeps the typed title and keyword
    const created = await req("POST", "/", { siteId: site.id, title: "How to price plumbing jobs", angle: "flat rate", primaryKeyword: "plumbing pricing" });
    assert.equal(created.status, 201);
    const { idea } = await json(created);
    assert.deepEqual([idea.status, idea.origin, idea.title, idea.primaryKeyword, idea.angle], ["new", "manual", "How to price plumbing jobs", "plumbing pricing", "flat rate"]);
    assert.ok(idea.score > 0);
    assert.deepEqual(idea.brief.outline, ["a", "b", "c"]);
    for (const k of ["trend", "fit", "demand", "feasibility", "novelty", "gain", "keyword", "nearestPost", "rationale"]) assert.ok(k in idea.scoreBreakdown, k);
    assert.equal((await req("POST", "/", { siteId: site.id, title: "x" })).status, 400);
    assert.equal((await req("POST", "/", { siteId: theirSite.id, title: "Another user's site" })).status, 404);
    // without a model the idea is still saved, unscored
    const noModel = createIdeasRoutes({ discoveryDeps: async () => { throw new Error("no key"); } });
    const bare = await json(await new Hono().use("*", async (c, next) => { c.set("userId" as never, owner.id as never); await next(); }).route("/", noModel)
      .request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId: site.id, title: "Unscored manual idea" }) }));
    assert.deepEqual([bare.idea.score, bare.idea.status], [null, "new"]);
    await db.delete(ideas).where(eq(ideas.id, bare.idea.id));

    // tenant: another user's idea or site is 404 on every route
    const calls: [string, string, unknown][] = [
      ["GET", `/?siteId=${site.id}`, undefined], ["POST", "/discover", { siteId: site.id }], ["GET", `/discoveries?siteId=${site.id}`, undefined],
      ["GET", `/calendar?siteId=${site.id}&from=2030-01-01&to=2030-02-01`, undefined],
      ["PATCH", `/${idea.id}`, { title: "Hijacked title" }], ["POST", `/${idea.id}/approve`, {}], ["POST", `/${idea.id}/reject`, {}],
      ["POST", `/${idea.id}/archive`, {}], ["POST", `/${idea.id}/write-now`, {}], ["POST", `/${idea.id}/reschedule`, { scheduledFor: "2030-01-01" }],
    ];
    for (const [m, path, body] of calls) assert.equal((await req(m, path, body, other.id)).status, 404, `${m} ${path}`);
    assert.equal((await req("GET", "/?siteId=nope")).status, 400);
    assert.equal((await req("PATCH", "/not-a-uuid", {})).status, 404);

    // list
    const list = await json(await req("GET", `/?siteId=${site.id}&status=new&sort=score`));
    assert.deepEqual(list.items.map((i: any) => i.id), [idea.id]);
    assert.equal((await req("GET", `/?siteId=${site.id}&status=bogus`)).status, 400);

    // edit, then approve with an owner-picked date and a taken date
    const patched = await json(await req("PATCH", `/${idea.id}`, { title: "How to price plumbing jobs fast", mode: "deep", outline: ["one", "two", "three", "four"] }));
    assert.deepEqual([patched.idea.title, patched.idea.mode, patched.idea.brief.outline.length, patched.idea.brief.whyNow], ["How to price plumbing jobs fast", "deep", 4, "because"]);
    assert.equal((await req("PATCH", `/${idea.id}`, { mode: "fast" })).status, 400);
    const when = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await req("POST", `/${idea.id}/approve`, { scheduledFor: "2020-01-01" })).status, 400, "past dates are refused");
    const approved = await req("POST", `/${idea.id}/approve`, { scheduledFor: when, angle: "new angle" });
    assert.equal(approved.status, 200);
    const approvedIdea = (await json(approved)).idea;
    assert.deepEqual([approvedIdea.status, approvedIdea.angle, approvedIdea.scheduledFor.slice(0, 10)], ["scheduled", "new angle", when]);
    assert.equal((await req("POST", `/${idea.id}/approve`, {})).status, 409, "only a new idea is approved");
    const second = (await json(await req("POST", "/", { siteId: site.id, title: "Second manual idea here" }))).idea;
    assert.equal((await req("POST", `/${second.id}/approve`, { scheduledFor: approvedIdea.scheduledFor })).status, 409, "a slot holds one idea");
    const auto = (await json(await req("POST", `/${second.id}/approve`, {}))).idea;
    assert.equal(auto.status, "scheduled");
    assert.notEqual(auto.scheduledFor, approvedIdea.scheduledFor);
    assert.ok(new Date(auto.scheduledFor).getTime() > Date.now() + 3 * 86_400_000 - 1000, "after the lead days");

    // reschedule, calendar
    assert.equal((await req("POST", `/${idea.id}/reschedule`, {})).status, 400);
    const moved = (await json(await req("POST", `/${idea.id}/reschedule`, { scheduledFor: auto.scheduledFor }).then(async (r) => { assert.equal(r.status, 409); return req("POST", `/${idea.id}/reschedule`, { scheduledFor: new Date(Date.now() + 25 * 86_400_000).toISOString() }); }))).idea;
    assert.equal(moved.status, "scheduled");
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const cal = await json(await req("GET", `/calendar?siteId=${site.id}&from=${from}&to=${to}`));
    assert.equal(cal.timezone, "UTC");
    const filled = cal.slots.filter((s: any) => s.idea);
    assert.deepEqual(filled.map((s: any) => s.idea.id).sort(), [auto.id, idea.id].sort());
    assert.ok(cal.slots.some((s: any) => !s.idea && s.isCadenceSlot), "empty cadence slots are listed");
    assert.deepEqual(Object.keys(filled[0]).sort(), ["at", "idea", "isCadenceSlot", "localDate", "post"]);
    assert.equal((await req("GET", `/calendar?siteId=${site.id}&from=${from}&to=2099-01-01`)).status, 400, "range is capped");

    // write now keeps the slot; a second call conflicts
    const wn = await req("POST", `/${idea.id}/write-now`, {});
    assert.equal(wn.status, 200);
    const wnBody = await json(wn);
    assert.deepEqual([wnBody.idea.status, wnBody.idea.scheduledFor === moved.scheduledFor, typeof wnBody.run.jobId, wnBody.idea.jobId === wnBody.run.jobId], ["in_progress", true, "string", true]);
    assert.equal((await req("POST", `/${idea.id}/write-now`, {})).status, 409);
    assert.equal((await req("PATCH", `/${idea.id}`, { title: "Too late to edit" })).status, 409);

    // reject frees the slot; archive hides
    const rejected = (await json(await req("POST", `/${second.id}/reject`, { reason: "off topic" }))).idea;
    assert.deepEqual([rejected.status, rejected.rejectedReason, rejected.scheduledFor], ["rejected", "off topic", null]);
    assert.equal((await req("POST", `/${second.id}/archive`, {})).status, 200);
    assert.equal((await json(await req("GET", `/?siteId=${site.id}`))).items.some((i: any) => i.id === second.id), false, "archived ideas are hidden by default");

    // discover: one per site; the response shape
    const d1 = await req("POST", "/discover", { siteId: site.id });
    assert.equal(d1.status, 202);
    const d1b = await json(d1);
    assert.deepEqual([d1b.created, d1b.discovery.status, Object.keys(d1b.discovery).sort()], [true, "queued", ["costUsd", "createdAt", "error", "finishedAt", "id", "ideaCount", "signalCount", "siteId", "startedAt", "status"]]);
    assert.equal((await json(await req("POST", "/discover", { siteId: site.id }))).created, false);
    assert.equal((await json(await req("GET", `/discoveries?siteId=${site.id}`))).items.length, 1);

    // ledger: ids and status only
    const events = await db.select().from(operationEvents).where(eq(operationEvents.userId, owner.id));
    const actions = new Set(events.map((e) => e.action));
    for (const a of ["ideas.create", "ideas.edit", "ideas.approve", "ideas.reschedule", "ideas.write_now", "ideas.reject", "ideas.archive", "ideas.discover"]) assert.ok(actions.has(a), a);
    for (const e of events) assert.ok(!JSON.stringify(e.metadata).match(/plumb|price|angle/i), "no idea text in the ledger");

    // settings: read, validate, write, scoped to the owner
    const sapp = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", settingsRoutes).onError(handleApiError);
    const sreq = (method: string, path: string, body?: unknown, userId = owner.id) => sapp(userId).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.deepEqual((await json(await sreq("GET", `/ideas?siteId=${site.id}`))).settings.cadence, { weekdays: [1, 4], time: "08:00", timezone: "UTC" });
    assert.equal((await sreq("GET", `/ideas?siteId=${site.id}`, undefined, other.id)).status, 404);
    assert.equal((await sreq("PUT", "/ideas", { siteId: site.id, settings: { cadence: { timezone: "Mars/Base" } } })).status, 400);
    assert.equal((await sreq("PUT", "/ideas", { siteId: site.id, settings: { leadDays: 1 } }, other.id)).status, 404);
    const put = await json(await sreq("PUT", "/ideas", { siteId: site.id, settings: { leadDays: 1, cadence: { weekdays: [2], time: "09:30", timezone: "Europe/Berlin" }, autopilot: { enabled: true } } }));
    assert.deepEqual([put.settings.leadDays, put.settings.cadence, put.settings.autopilot.enabled], [1, { weekdays: [2], time: "09:30", timezone: "Europe/Berlin" }, true]);
    assert.deepEqual((await json(await sreq("GET", `/ideas?siteId=${site.id}`))).settings, put.settings);
    console.log("ideas routes self-test ok");
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  process.exit(0);
}
