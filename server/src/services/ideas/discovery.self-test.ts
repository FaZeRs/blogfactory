import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ideas discovery self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable database)");
} else {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { users, sites, posts, ideas, ideaDiscoveries, generationLogs, operationEvents, searchConsoleMetrics } = await import("../../db/schema.js");
  const { createFakeLlm } = await import("../../engine/adapters/fake-llm.js");
  const { createFakeSearch } = await import("../../engine/adapters/fakes.js");
  const { queueDiscovery, runDiscovery, drainIdeaDiscoveries } = await import("./discovery.js");
  const { getIdeaSettings, saveIdeaSettings } = await import("./settings.js");

  const [user, other] = await db.insert(users).values([
    { email: `ideas-${randomUUID()}@example.test`, passwordHash: "x" },
    { email: `ideas-${randomUUID()}@example.test`, passwordHash: "x" },
  ]).returning();
  try {
    const [site] = await db.insert(sites).values({ userId: user.id, name: "Plumb", domain: "plumb.example.test", topics: ["plumbing crm"] }).returning();
    const [foreign] = await db.insert(sites).values({ userId: other.id, name: "O", domain: "o.example.test" }).returning();
    await db.insert(posts).values({ userId: user.id, siteId: site.id, title: "Best CRM tools for plumbers", content: "c", sourceType: "raw_text", modelId: "m" });
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(searchConsoleMetrics).values([
      { userId: user.id, siteId: site.id, date: today, pageUrl: "https://plumb.example.test/a", query: "crm for plumbers", impressions: 200, clicks: 3, position: 12 },
      { userId: user.id, siteId: site.id, date: today, pageUrl: "https://plumb.example.test/a", query: "ranks already", impressions: 500, clicks: 90, position: 2 },
    ]);

    // settings round trip, scoped to the site
    assert.equal((await getIdeaSettings(user.id, site.id)).defaultMode, "normal");
    await saveIdeaSettings(user.id, site.id, { defaultMode: "deep", leadDays: 5 });
    const saved = await getIdeaSettings(user.id, site.id);
    assert.deepEqual([saved.defaultMode, saved.leadDays, saved.cadence.weekdays], ["deep", 5, [1, 4]]);

    // queueing: another user's site is refused, one active discovery per site
    await assert.rejects(queueDiscovery(user.id, foreign.id), /Site not found/);
    const first = await queueDiscovery(user.id, site.id);
    const second = await queueDiscovery(user.id, site.id);
    assert.deepEqual([first.created, second.created, second.id], [true, false, first.id]);

    const idea = (title: string, keyword: string, over: object = {}) => ({
      title, angle: "a point of view", primaryKeyword: keyword, alternateKeywords: [], searchIntent: "informational", audienceQuestion: "q",  outline: ["One", "Two", "Three"], whyNow: "now",
      informationGain: ["new data"], signalIds: ["s1"], fit: 8, gain: 6, demandEstimate: 7, rationale: "r", ...over,
    });
    const llm = createFakeLlm({ brief: [{ ideas: [
      idea("CRM onboarding checklist for plumbers", "crm onboarding plumbers"),
      idea("Best CRM tools for plumbers", "crm tools plumbers"),          // duplicate of the post
      idea("Scheduling software for plumbing crews", "plumber scheduling software"),
    ] }] });
    const deps = {
      llm, model: "test/model", dataForSeo: null, dataForSeoSpent: () => 0.01,
      collectors: {
        now: () => new Date(), dataForSeo: null,
        search: createFakeSearch({ "plumbing crm": [{ url: "https://news.example.test/a", title: "Plumbing CRM news", snippet: "s" }] }),
        fetchText: async () => "", fetchFeed: async () => [],
      },
    };
    const result = await runDiscovery(first.id, deps as never);
    assert.ok(result);
    assert.equal(result.signalCount, 1 + 1, "one Search Console query (position 8-30) and one news item");
    assert.equal(result.ideaCount, 2, "the near-duplicate of a post is dropped");
    assert.equal(result.costUsd, 0.01);

    const rows = await db.select().from(ideas).where(and(eq(ideas.userId, user.id), eq(ideas.siteId, site.id)));
    assert.deepEqual(rows.map((r) => r.title).sort(), ["CRM onboarding checklist for plumbers", "Scheduling software for plumbing crews"]);
    const row = rows[0];
    assert.deepEqual([row.status, row.origin, row.mode, row.discoveryId], ["new", "discovered", "deep", first.id]);
    assert.ok((row.score ?? 0) > 0);
    const breakdown = row.scoreBreakdown as Record<string, unknown>;
    for (const k of ["trend", "fit", "demand", "feasibility", "novelty", "gain", "keyword", "nearestPost", "rationale"]) assert.ok(k in breakdown, k);
    assert.deepEqual(Object.keys(row.brief as object).sort(), ["informationGain", "outline", "sources", "suggestedMode", "whyNow"]);

    const [disc] = await db.select().from(ideaDiscoveries).where(eq(ideaDiscoveries.id, first.id));
    assert.deepEqual([disc.status, disc.ideaCount, disc.signalCount], ["done", 2, 2]);
    assert.ok(disc.finishedAt);
    assert.equal(await runDiscovery(first.id, deps as never), null, "a finished discovery is not run again");

    const [log] = await db.select().from(generationLogs).where(eq(generationLogs.userId, user.id));
    assert.deepEqual([log.usageType, log.cost, log.sessionId], ["text", 0.01, first.id]);
    assert.deepEqual(log.responseData, { ideas: { discoveryId: first.id } });
    const events = await db.select().from(operationEvents).where(and(eq(operationEvents.userId, user.id), eq(operationEvents.action, "ideas.discovery")));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "succeeded");
    assert.deepEqual(events[0].metadata, { signal_count: 2, idea_count: 2, cost_usd: 0.01, sources: "gsc,news", failed_collectors: 0 });
    assert.ok(!JSON.stringify(events[0].metadata).includes("plumb"), "no text in the ledger");

    // a second discovery skips ideas that exist and records a failure without throwing from the drain
    const again = await queueDiscovery(user.id, site.id);
    assert.equal(again.created, true, "the first one is done, so a new one can be queued");
    const llm2 = createFakeLlm({ brief: [{ ideas: [idea("CRM onboarding checklist for plumber", "crm onboarding plumbers"), idea("Invoicing tips for plumbers", "plumber invoicing")] }] });
    const drained = await drainIdeaDiscoveries(2, { ...deps, llm: llm2 } as never);
    assert.deepEqual(drained, { processed: 1, failed: 0 });
    const titles = (await db.select({ title: ideas.title }).from(ideas).where(eq(ideas.siteId, site.id))).map((r) => r.title);
    assert.equal(titles.length, 3);
    assert.ok(titles.includes("Invoicing tips for plumbers") && !titles.includes("CRM onboarding checklist for plumber"));

    const bad = await queueDiscovery(user.id, site.id);
    const failed = await drainIdeaDiscoveries(1, { ...deps, llm: createFakeLlm({}) } as never);
    assert.deepEqual(failed, { processed: 1, failed: 1 });
    const [failedRow] = await db.select().from(ideaDiscoveries).where(eq(ideaDiscoveries.id, bad.id));
    assert.equal(failedRow.status, "failed");
    assert.ok(failedRow.error);
    assert.deepEqual(await drainIdeaDiscoveries(1, deps as never), { processed: 0, failed: 0 });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  console.log("ideas discovery self-test passed");
  process.exit(0);
}
