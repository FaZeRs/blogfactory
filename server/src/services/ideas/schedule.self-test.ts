import assert from "node:assert/strict";
import { DEFAULT_IDEA_SETTINGS } from "./settings.js";
import { cadenceSlots, parseScheduledFor, slotsBetween, zonedTimeToUtc } from "./schedule.js";

// slots: weekdays, time and DST, through Intl only
const berlin = { weekdays: [1], time: "08:00", timezone: "Europe/Berlin" };
const iso = (ds: Date[]) => ds.map((d) => d.toISOString());
assert.deepEqual(
  iso(slotsBetween(berlin, new Date("2026-03-20T00:00:00Z"), new Date("2026-04-07T00:00:00Z"))),
  ["2026-03-23T07:00:00.000Z", "2026-03-30T06:00:00.000Z", "2026-04-06T06:00:00.000Z"], "Monday 08:00 Berlin moves from CET to CEST");
const ny = { weekdays: [4], time: "08:00", timezone: "America/New_York" };
assert.deepEqual(
  iso(slotsBetween(ny, new Date("2026-10-29T00:00:00Z"), new Date("2026-11-06T00:00:00Z"))),
  ["2026-10-29T12:00:00.000Z", "2026-11-05T13:00:00.000Z"], "Thursday 08:00 New York moves from EDT to EST");
assert.equal(zonedTimeToUtc(2026, 11, 5, 8, 0, "America/New_York").toISOString(), "2026-11-05T13:00:00.000Z");
assert.equal(zonedTimeToUtc(2026, 10, 29, 8, 0, "America/New_York").toISOString(), "2026-10-29T12:00:00.000Z");
const day = [...cadenceSlots({ weekdays: [1, 4], time: "08:00", timezone: "UTC" }, new Date("2026-11-02T08:00:00Z"))][0]!;
assert.equal(day.toISOString(), "2026-11-02T08:00:00.000Z", "a slot at exactly `from` counts");
assert.equal(parseScheduledFor("2026-11-10", berlin)!.toISOString(), "2026-11-10T07:00:00.000Z", "a date takes the cadence time in the site zone");
assert.equal(parseScheduledFor("nope", berlin), null);
assert.equal(parseScheduledFor("2026-02-30", berlin), null, "an impossible day is refused, not rolled over");

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ideas schedule self-test: pure parts passed; lifecycle skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable database)");
} else {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { users, sites, ideas, jobs, articleRuns, posts, operationEvents } = await import("../../db/schema.js");
  const { mirrorJob } = await import("../../engine/runtime/advance.js");
  const { bookIdea, nextFreeSlot, SlotTakenError, startDueIdeas, startIdea, runAutopilot } = await import("./schedule.js");
  const { saveIdeaSettings, getIdeaSettings } = await import("./settings.js");

  const [user, other] = await db.insert(users).values([
    { email: `sched-${randomUUID()}@example.test`, passwordHash: "x" },
    { email: `sched-${randomUUID()}@example.test`, passwordHash: "x" },
  ]).returning();
  try {
    const [site] = await db.insert(sites).values({ userId: user.id, name: "S", domain: "s.example.test" }).returning();
    await saveIdeaSettings(user.id, site.id, { ...DEFAULT_IDEA_SETTINGS, leadDays: 3, cadence: { weekdays: [0, 1, 2, 3, 4, 5, 6], time: "08:00", timezone: "UTC" } });
    const settings = await getIdeaSettings(user.id, site.id);
    const mk = async (title: string, over: object = {}) => (await db.insert(ideas).values({ userId: user.id, siteId: site.id, title, primaryKeyword: "kw", angle: "an angle", brief: { whyNow: "w", outline: ["a", "b", "c"], informationGain: ["g"] }, ...over }).returning())[0]!;

    // no double booking: concurrent approvals land on distinct slots; a taken date is refused
    const [a, b, c, d] = [await mk("idea a"), await mk("idea b"), await mk("idea c"), await mk("idea d")];
    const booked = await Promise.all([a, b, c].map((i) => bookIdea({ userId: user.id, siteId: site.id, ideaId: i.id, settings, from: ["new"] })));
    const times = booked.map((r) => r!.scheduledFor!.getTime());
    assert.equal(new Set(times).size, 3, "three distinct slots");
    assert.ok(Math.min(...times) >= Date.now() + 3 * 86_400_000, "at least leadDays out");
    await assert.rejects(bookIdea({ userId: user.id, siteId: site.id, ideaId: d.id, settings, from: ["new"], scheduledFor: booked[0]!.scheduledFor! }), SlotTakenError);
    const free = await nextFreeSlot(user.id, site.id, settings, new Date());
    assert.ok(!times.includes(free.getTime()), "nextFreeSlot skips booked slots");
    assert.equal(await bookIdea({ userId: user.id, siteId: site.id, ideaId: a.id, settings, from: ["new"] }), null, "only new ideas can be approved");
    assert.equal(await bookIdea({ userId: other.id, siteId: site.id, ideaId: d.id, settings, from: ["new"] }), null, "another user cannot book it");

    // due start: only ideas inside their lead time, with guidance, cover off without an image model
    const calls: any[] = [];
    const fakeRun = async (input: any) => { calls.push(input); const [job] = await db.insert(jobs).values({ userId: user.id, siteId: site.id, sourceType: "article_title", sourceValue: input.topic, modelId: "m" }).returning(); return { jobId: job.id, runId: randomUUID(), estimateUsd: 1 }; };
    const now = new Date();
    const due = await mk("due idea", { status: "scheduled", scheduledFor: new Date(now.getTime() + 2 * 86_400_000) });
    const later = await mk("later idea", { status: "scheduled", scheduledFor: new Date(now.getTime() + 20 * 86_400_000) });
    await db.update(ideas).set({ scheduledFor: new Date(now.getTime() + 40 * 86_400_000) }).where(eq(ideas.id, a.id));
    await db.update(ideas).set({ scheduledFor: new Date(now.getTime() + 41 * 86_400_000) }).where(eq(ideas.id, b.id));
    await db.update(ideas).set({ scheduledFor: new Date(now.getTime() + 42 * 86_400_000) }).where(eq(ideas.id, c.id));
    assert.deepEqual(await startDueIdeas(now, fakeRun as never), { started: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].topic, calls[0].sourceType, calls[0].mode, calls[0].cover, calls[0].guidance.angle], ["due idea", "article_title", "normal", false, "an angle"]);
    assert.match(calls[0].guidance.instructions, /Primary keyword: kw/);
    const [started] = await db.select().from(ideas).where(eq(ideas.id, due.id));
    assert.equal(started.status, "in_progress");
    assert.ok(started.jobId);
    assert.deepEqual(await startDueIdeas(now, fakeRun as never), { started: 0, failed: 0 }, "not started twice");
    assert.equal((await db.select().from(ideas).where(eq(ideas.id, later.id)))[0]!.status, "scheduled");

    // a start that fails keeps the idea scheduled with the error and waits 30 minutes
    const failing = async () => { throw new Error("worker_required"); };
    const wait = await mk("retry idea", { status: "scheduled", scheduledFor: new Date(now.getTime() + 86_400_000) });
    assert.deepEqual(await startDueIdeas(now, failing as never), { started: 0, failed: 1 });
    const [errored] = await db.select().from(ideas).where(eq(ideas.id, wait.id));
    assert.deepEqual([errored.status, errored.error], ["scheduled", "worker_required"]);
    assert.deepEqual(await startDueIdeas(new Date(now.getTime() + 10 * 60_000), failing as never), { started: 0, failed: 0 }, "backoff");
    assert.deepEqual(await startDueIdeas(new Date(now.getTime() + 31 * 60_000), fakeRun as never), { started: 1, failed: 0 }, "retried after 30 minutes");
    // write now from the inbox without a slot: a failure returns it to new
    const w = await mk("write now idea");
    await assert.rejects(startIdea(user.id, site.id, w.id, failing as never), /worker_required/);
    assert.deepEqual((await db.select({ s: ideas.status, e: ideas.error }).from(ideas).where(eq(ideas.id, w.id)))[0], { s: "new", e: "worker_required" });
    assert.equal(await startIdea(other.id, site.id, w.id, fakeRun as never), null, "another user cannot start it");

    // delivery: the post links back with the slot as publish_at; a failed run returns the idea
    const run = async (state: string, postId: string | null, jobId: string) => {
      const [row] = await db.insert(articleRuns).values({ userId: user.id, siteId: site.id, jobId, mode: "normal", sourceType: "article_title", topic: "t", settings: {}, budgetUsd: 1, state, postId, stateReason: state === "failed" ? "boom" : null }).returning();
      await db.transaction((tx) => mirrorJob(tx, row, new Date()));
    };
    const [post] = await db.insert(posts).values({ userId: user.id, siteId: site.id, title: "t", content: "c", sourceType: "article_title", modelId: "m" }).returning();
    await run("done", post.id, started.jobId!);
    const [drafted] = await db.select().from(ideas).where(eq(ideas.id, due.id));
    assert.deepEqual([drafted.status, drafted.postId], ["drafted", post.id]);
    const [withSlot] = await db.select({ p: posts.publishAt }).from(posts).where(eq(posts.id, post.id));
    assert.equal(withSlot.p?.getTime(), started.scheduledFor!.getTime());
    const [retried] = await db.select().from(ideas).where(eq(ideas.id, wait.id));
    await run("failed", null, retried.jobId!);
    const [back] = await db.select().from(ideas).where(eq(ideas.id, wait.id));
    assert.deepEqual([back.status, back.error], ["scheduled", "boom"]);

    // autopilot: top ideas at or above minScore, capped per week, counting this week's
    const auto = { ...settings, autopilot: { enabled: true, approvePerWeek: 2, minScore: 60 } };
    const fresh = await Promise.all([["hi", 90], ["mid", 70], ["low", 50], ["top", 95]].map(([t, s]) => mk(`auto ${t}`, { score: s })));
    assert.equal(await runAutopilot(user.id, site.id, { ...settings, autopilot: { ...auto.autopilot, enabled: false } }), 0);
    // updated_at this week: earlier tests already scheduled/started ideas, so lift the cap for the first check
    assert.equal(await runAutopilot(user.id, site.id, { ...auto, autopilot: { ...auto.autopilot, approvePerWeek: 14 } }), 3, "only scores of 60 and up");
    const approved = await db.select({ t: ideas.title, s: ideas.status }).from(ideas).where(and(eq(ideas.siteId, site.id), eq(ideas.status, "scheduled")));
    assert.ok(approved.some((r) => r.t === "auto top") && approved.some((r) => r.t === "auto hi"));
    assert.equal(fresh.length, 4);
    assert.equal(await runAutopilot(user.id, site.id, auto), 0, "the weekly cap counts ideas already approved this week");
    const events = await db.select({ a: operationEvents.action, m: operationEvents.metadata }).from(operationEvents).where(and(eq(operationEvents.userId, user.id), eq(operationEvents.action, "ideas.approve")));
    assert.equal(events.length, 3);
    assert.deepEqual(events[0]!.m, { status: "scheduled" });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  console.log("ideas schedule self-test passed");
  process.exit(0);
}
console.log("ideas schedule self-test (pure) passed");
