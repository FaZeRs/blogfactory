import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ai-visibility run self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable database)");
} else {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { users, sites, aiAnswerChecks, generationLogs, operationEvents } = await import("../../db/schema.js");
  const { saveIdeaSettings } = await import("../ideas/settings.js");
  const { getVisibilitySettings, saveVisibilitySettings } = await import("./settings.js");
  const { drainVisibility, isoWeek, runVisibility, visibilityRunning } = await import("./run.js");
  const { visibilitySummary } = await import("./summary.js");
  const { questionHash } = await import("./questions.js");
  const { EngineError, QuotaError } = await import("./engines.js");

  const [user, other] = await db.insert(users).values([
    { email: `vis-${randomUUID()}@example.test`, passwordHash: "x" },
    { email: `vis-${randomUUID()}@example.test`, passwordHash: "x" },
  ]).returning();
  try {
    const [site] = await db.insert(sites).values({ userId: user.id, name: "Plumb", domain: "plumb.example.test" }).returning();
    const [tight] = await db.insert(sites).values({ userId: user.id, name: "Tight", domain: "tight.example.test" }).returning();
    const [foreign] = await db.insert(sites).values({ userId: other.id, name: "O", domain: "o.example.test" }).returning();
    const questions = ["how do I find a plumber?", "best crm for plumbers?", "what does a boiler repair cost?", "how to schedule a crew?", "is a plumbing app worth it?"];
    const engines = ["openai/a", "perplexity/b"];
    await saveIdeaSettings(user.id, site.id, { competitors: ["rival.example.test"] });
    await saveVisibilitySettings(user.id, site.id, { enabled: true, questions, engines, monthlyCapUsd: 5 });
    await saveVisibilitySettings(user.id, tight.id, { enabled: true, questions, engines, monthlyCapUsd: 0.01 });
    const saved = await getVisibilitySettings(user.id, site.id);
    assert.deepEqual([saved.questions.length, saved.engines], [5, engines]);
    await assert.rejects(getVisibilitySettings(other.id, site.id), /Site not found/);
    await assert.rejects(runVisibility(other.id, site.id, { apiKey: "k" }), /Site not found/);
    await assert.rejects(runVisibility(user.id, foreign.id, { apiKey: "k" }), /Site not found/);

    // no OpenRouter key
    assert.deepEqual(await runVisibility(user.id, site.id), { status: "unavailable" });

    const now = new Date("2026-11-04T10:00:00Z"); // Wednesday, 2026-W45
    const week = isoWeek(now);
    const calls: string[] = [];
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const ok = (host: string[], text = "An answer") => async (a: { model: string; question: string }) => {
      calls.push(`${a.model}|${a.question}`);
      return { answer: text, citations: host.map((url) => ({ url })), costUsd: 0.01, model: a.model };
    };
    const ask = async (a: { apiKey: string; model: string; question: string }) =>
      a.question.startsWith("best crm")
        ? ok(["https://www.plumb.example.test/crm?utm_source=x", "https://rival.example.test/a"], "Try Plumb")(a)
        : ok(["https://rival.example.test/a", "https://other.example/b"])(a);

    const first = await runVisibility(user.id, site.id, { now, ask, sleep, apiKey: "k" });
    assert.deepEqual(first, { status: "done", week, asked: 10, cited: 2, failed: 0, costUsd: 0.1 });
    assert.equal(calls.length, 10);
    assert.deepEqual([sleeps.length, new Set(sleeps).size, sleeps[0]], [9, 1, 2000], "2s between calls, none before the first");
    const rows = await db.select().from(aiAnswerChecks).where(eq(aiAnswerChecks.siteId, site.id));
    assert.equal(rows.length, 10);
    const hit = rows.find((r) => r.cited)!;
    assert.deepEqual([hit.week, hit.status, hit.mentioned, hit.competitorHosts, hit.otherHosts], [week, "ok", true, ["rival.example.test"], ["rival.example.test"]]);
    assert.deepEqual(hit.citedUrls, ["https://www.plumb.example.test/crm"]);
    assert.deepEqual(new Set(rows.map((r) => r.engineLabel)), new Set(["OpenAI", "Perplexity"]));
    assert.equal((await db.select().from(generationLogs).where(eq(generationLogs.userId, user.id))).filter((l) => (l.responseData as any)?.aiVisibility?.siteId === site.id).length, 10);
    const events = await db.select().from(operationEvents).where(and(eq(operationEvents.userId, user.id), eq(operationEvents.action, "ai_visibility.run")));
    assert.deepEqual(events.map((e) => [e.status, e.metadata]), [["succeeded", { asked: 10, cited: 2, failed: 0, cost_usd: 0.1 }]]);
    assert.ok(!JSON.stringify(events).includes("An answer"));
    assert.equal(await visibilityRunning(user.id, site.id, now), false);

    // idempotent within the week
    const again = await runVisibility(user.id, site.id, { now, ask, sleep, apiKey: "k" });
    assert.deepEqual(again, { status: "done", week, asked: 0, cited: 0, failed: 0, costUsd: 0 });
    assert.equal(calls.length, 10);

    // failed rows are retried in place, an ok row is never overwritten
    await db.delete(aiAnswerChecks).where(and(eq(aiAnswerChecks.siteId, site.id), eq(aiAnswerChecks.engine, "perplexity/b")));
    const flaky = async (a: { apiKey: string; model: string; question: string }) => {
      if (a.question.startsWith("how do")) throw Object.assign(new EngineError("HTTP 500", 500), { costUsd: 0.003 });
      return ask(a);
    };
    const afterFail = await runVisibility(user.id, site.id, { now, ask: flaky, sleep, apiKey: "k" });
    assert.deepEqual([afterFail.status, (afterFail as any).asked, (afterFail as any).failed], ["done", 5, 1]);
    const failedRows = await db.select().from(aiAnswerChecks).where(and(eq(aiAnswerChecks.siteId, site.id), eq(aiAnswerChecks.status, "failed")));
    assert.deepEqual(failedRows.map((r) => [r.engine, r.error, r.answer, r.question]), [["perplexity/b", "HTTP 500", null, "how do I find a plumber?"]]);
    assert.equal(failedRows[0]!.costUsd, 0.003, "a failed call that cost money is booked");
    // a scheduled run backs off: the failure is minutes old, so nothing is asked yet
    const backoff = await runVisibility(user.id, site.id, { now: new Date(), ask, sleep, apiKey: "k", failedBackoffMs: 6 * 60 * 60_000 });
    assert.deepEqual([backoff.status, (backoff as any).asked], ["done", 0]);
    const before = calls.length;
    const retried = await runVisibility(user.id, site.id, { now, ask, sleep, apiKey: "k" });
    assert.deepEqual([(retried as any).asked, (retried as any).failed], [1, 0]);
    assert.equal(calls.length - before, 1);
    const fixed = await db.select().from(aiAnswerChecks).where(and(eq(aiAnswerChecks.siteId, site.id), eq(aiAnswerChecks.questionHash, questionHash("how do I find a plumber?")), eq(aiAnswerChecks.engine, "perplexity/b")));
    assert.deepEqual([fixed.length, fixed[0]!.status], [1, "ok"]);
    assert.ok(Math.abs(fixed[0]!.costUsd - 0.013) < 1e-6, "retry adds to the failed try's cost");

    // monthly cap
    const capped = await runVisibility(user.id, tight.id, { now, ask, sleep, apiKey: "k" });
    assert.equal(capped.status, "capped");
    assert.equal((capped as any).spentUsd, 0);
    assert.equal(calls.length - before, 1, "capped made no calls");

    // quota stops that engine for the run
    const next = new Date("2026-11-11T10:00:00Z");
    const qcalls: string[] = [];
    const quota = async (a: { apiKey: string; model: string; question: string }) => {
      qcalls.push(a.model);
      if (a.model === "perplexity/b") throw new QuotaError(402);
      return ask(a);
    };
    const q = await runVisibility(user.id, site.id, { now: next, ask: quota, sleep, apiKey: "k" });
    assert.deepEqual([q.status, (q as any).asked, (q as any).failed], ["done", 6, 1]);
    assert.equal(qcalls.filter((m) => m === "perplexity/b").length, 1);
    assert.equal(qcalls.filter((m) => m === "openai/a").length, 5);

    // 429 is waited out (twice at most), then recorded as failed
    const week3 = new Date("2026-11-18T10:00:00Z");
    const { RateLimitError } = await import("./engines.js");
    await saveVisibilitySettings(user.id, site.id, { enabled: true, questions: [questions[0]], engines: ["openai/a"], monthlyCapUsd: 5 });
    sleeps.length = 0;
    let n = 0;
    const limited = async (a: { apiKey: string; model: string; question: string }) => {
      n += 1;
      if (n <= 2) throw new RateLimitError(200_000);
      return ask(a);
    };
    const r429 = await runVisibility(user.id, site.id, { now: week3, ask: limited, sleep, apiKey: "k" });
    assert.deepEqual([(r429 as any).asked, (r429 as any).failed, n], [1, 0, 3]);
    assert.deepEqual(sleeps, [90_000, 90_000], "waits min(retryAfter, 90s)");
    sleeps.length = 0; n = -10;
    const wk4 = new Date("2026-11-25T10:00:00Z");
    const stuck = await runVisibility(user.id, site.id, { now: wk4, ask: async () => { throw new RateLimitError(1000); }, sleep, apiKey: "k" });
    assert.deepEqual([(stuck as any).asked, (stuck as any).failed], [1, 1]);
    assert.deepEqual(sleeps, [1000, 1000]);

    // running state: fresh blocks, stale does not, and it is cleared after
    await saveVisibilitySettings(user.id, site.id, { enabled: true, questions: [questions[1]], engines: ["openai/a"], monthlyCapUsd: 5 });
    const wk5 = new Date("2026-12-02T10:00:00Z");
    await db.update(sites).set({ aiVisibilityRunStartedAt: new Date(wk5.getTime() - 5 * 60_000) }).where(eq(sites.id, site.id));
    assert.equal(await visibilityRunning(user.id, site.id, wk5), true);
    assert.deepEqual(await runVisibility(user.id, site.id, { now: wk5, ask, sleep, apiKey: "k" }), { status: "running" });
    await db.update(sites).set({ aiVisibilityRunStartedAt: new Date(wk5.getTime() - 31 * 60_000) }).where(eq(sites.id, site.id));
    assert.equal(await visibilityRunning(user.id, site.id, wk5), false);
    assert.equal((await runVisibility(user.id, site.id, { now: wk5, ask, sleep, apiKey: "k" })).status, "done");
    assert.equal(await visibilityRunning(user.id, site.id), false);

    // a throwing run clears the claim
    const wk6 = new Date("2026-12-09T10:00:00Z");
    // a per-call error is recorded, not thrown; the claim is released either way
    const boom = await runVisibility(user.id, site.id, { now: wk6, sleep, apiKey: "k", ask: async () => { throw new Error("db down"); } });
    assert.deepEqual([boom.status, (boom as any).failed], ["done", 1]);
    assert.equal(await visibilityRunning(user.id, site.id), false);

    // summary: shares, gaps, twoWeeks, trend
    const [s3] = await db.insert(sites).values({ userId: user.id, name: "Sum", domain: "sum.example.test" }).returning();
    const put = (w: string, qn: string, engine: string, over: Partial<typeof aiAnswerChecks.$inferInsert> = {}) =>
      db.insert(aiAnswerChecks).values({ userId: user.id, siteId: s3.id, week: w, question: qn, questionHash: questionHash(qn), engine, engineLabel: engine.split("/")[0]!, status: "ok", answer: "a", costUsd: 0.01, ...over });
    const A = "question alpha here?", B = "question beta here?", C = "question gamma here?", D = "question delta here?";
    // 2026-W44: A cited by engine 1 only; B gap (rival); C no hosts; D failed
    await put("2026-W44", A, "e/1", { cited: true, citedUrls: ["https://sum.example.test/a"], mentioned: true });
    await put("2026-W44", A, "e/2", { otherHosts: ["x.test"] });
    await put("2026-W44", B, "e/1", { otherHosts: ["rival.test", "x.test"], competitorHosts: ["rival.test"] });
    await put("2026-W44", B, "e/2");
    await put("2026-W44", C, "e/1");
    await put("2026-W44", D, "e/1", { status: "failed", answer: null });
    // 2026-W45: B gap again, C gap (other host only), A lost, D cited
    await put("2026-W45", A, "e/1", { otherHosts: ["x.test"] });
    await put("2026-W45", A, "e/2", { otherHosts: ["x.test"] });
    await put("2026-W45", B, "e/1", { otherHosts: ["rival.test", "x.test", "y.test"], competitorHosts: ["rival.test"] });
    await put("2026-W45", B, "e/2", { otherHosts: ["x.test"] });
    await put("2026-W45", C, "e/1", { otherHosts: ["y.test"] });
    await put("2026-W45", D, "e/1", { cited: true, citedUrls: ["https://sum.example.test/d"], mentioned: true });
    await put("2026-W45", D, "e/2");
    const sum = await visibilitySummary(user.id, s3.id, new Date("2026-11-06T00:00:00Z"));
    assert.equal(sum.week, "2026-W45");
    assert.deepEqual([sum.latest.questions, sum.latest.answered, sum.latest.citedQuestions, sum.latest.share, sum.latest.mentionedShare], [4, 4, 1, 0.25, 0.25]);
    assert.deepEqual(sum.latest.engines, [{ engine: "e/1", label: "e", asked: 4, cited: 1, share: 0.25 }, { engine: "e/2", label: "e", asked: 3, cited: 0, share: 0 }]);
    assert.deepEqual(sum.trend, [{ week: "2026-W44", share: 1 / 3, answered: 3 }, { week: "2026-W45", share: 0.25, answered: 4 }]);
    assert.deepEqual(sum.topCompetitors, [{ host: "x.test", count: 4, flagged: false }, { host: "y.test", count: 2, flagged: false }, { host: "rival.test", count: 1, flagged: true }]);
    assert.deepEqual(sum.gaps, [
      { question: B, competitorHosts: ["rival.test"], otherHosts: ["x.test", "y.test"], twoWeeks: true },
      { question: A, competitorHosts: [], otherHosts: ["x.test"], twoWeeks: false },
      { question: C, competitorHosts: [], otherHosts: ["y.test"], twoWeeks: false },
    ]);
    assert.equal(sum.checks.length, 7);
    assert.equal(sum.costThisMonth, 0, "monthly spend comes from the spend log, not check rows");
    assert.ok(sum.checks.every((r) => !("userId" in r)));
    assert.ok(sum.costThisMonth >= 0);
    assert.deepEqual(await visibilitySummary(other.id, s3.id).then((x) => [x.week, x.checks.length, x.latest.share]), [null, 0, 0], "another user sees nothing");

    // a skipped week breaks "two weeks running": W47 follows W45, not W46
    await put("2026-W47", B, "e/1", { otherHosts: ["rival.test"], competitorHosts: ["rival.test"] });
    const skipped = await visibilitySummary(user.id, s3.id, new Date("2026-11-20T00:00:00Z"));
    assert.deepEqual(skipped.gaps.map((g) => [g.question, g.twoWeeks]), [[B, false]]);

    // the account guardrails are rechecked before every paid call: 2 requests a day stops a 4-call run after 2
    const { updateGlobalSettings } = await import("../user-settings.js");
    const [lim] = await db.insert(users).values({ email: `vis-${randomUUID()}@example.test`, passwordHash: "x" }).returning();
    try {
      const [limSite] = await db.insert(sites).values({ userId: lim.id, name: "Lim", domain: "lim.example.test" }).returning();
      await saveVisibilitySettings(lim.id, limSite.id, { enabled: true, questions: questions.slice(0, 2), engines, monthlyCapUsd: 5 });
      await updateGlobalSettings(lim.id, { dailyRequestLimit: 2 });
      const limited = await runVisibility(lim.id, limSite.id, { ask, sleep, apiKey: "k" });
      assert.deepEqual([limited.status, (limited as any).asked], ["done", 2]);
    } finally {
      await db.delete(users).where(eq(users.id, lim.id));
    }

    // drain: weekday gate and pending check
    const [d1] = await db.insert(sites).values({ userId: user.id, name: "Dr", domain: "dr.example.test" }).returning();
    await saveVisibilitySettings(user.id, d1.id, { enabled: true, questions: [questions[0]], engines: ["openai/a"], weekday: 4, monthlyCapUsd: 5 });
    // Tuesday is before the Thursday setting: nothing is attempted (a real run would need a key and the network)
    assert.deepEqual(await drainVisibility(new Date("2026-12-15T10:00:00Z"), 5), { processed: 0, failed: 0 });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  console.log("ai-visibility run self-test passed");
  process.exit(0);
}
