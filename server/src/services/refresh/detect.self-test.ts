import assert from "node:assert/strict";
import { classifyRefresh, pageKey, windows, MAX_NEW_PER_DAY, REFRESH_ANGLE } from "./detect.js";

// thresholds: age, click drop, position, striking distance
const w = (clicks: number, impressions: number, position: number) => ({ clicks, impressions, position });
const kind = (ageDays: number, current: ReturnType<typeof w>, previous: ReturnType<typeof w>) => classifyRefresh({ ageDays, current, previous })?.kind ?? null;
assert.equal(kind(89, w(5, 500, 3), w(50, 500, 3)), null, "younger than 90 days");
assert.equal(classifyRefresh({ ageDays: 90, current: w(7, 300, 3), previous: w(10, 300, 3) })?.reason, "clicks −30% (28d)", "exactly -30% with 10 previous clicks");
assert.equal(kind(200, w(8, 300, 3), w(10, 300, 3)), null, "-20% is not a decline");
assert.equal(kind(200, w(0, 300, 3), w(9, 300, 3)), null, "fewer than 10 previous clicks never counts as a click drop");
assert.equal(kind(200, w(10, 300, 7), w(10, 300, 2)), "declining", "position worse by 5");
assert.equal(kind(200, w(10, 300, 6.9), w(10, 300, 2)), null, "position worse by under 5");
assert.equal(kind(200, w(1, 100, 8), w(1, 0, 0)), "striking", "position 8 with 100 impressions");
assert.equal(kind(200, w(1, 100, 20), w(1, 0, 0)), "striking", "position 20");
assert.equal(kind(200, w(1, 99, 12), w(1, 0, 0)), null, "99 impressions");
assert.equal(kind(200, w(1, 500, 7.9), w(1, 0, 0)), null, "already on page one");
assert.equal(kind(200, w(1, 500, 20.1), w(1, 0, 0)), null, "too far down");
assert.equal(kind(200, w(1, 500, 12), w(20, 500, 12)), "declining", "declining wins over striking distance");
assert.deepEqual(windows(new Date("2026-11-07T12:00:00Z")), { curStart: "2026-10-08", curEnd: "2026-11-04", prevStart: "2026-09-10", prevEnd: "2026-10-07" }, "28 days ending 3 days ago, then the 28 before");
assert.equal(pageKey("https://www.Example.com/Blog/Post/?utm=1#x"), "example.com/blog/post");
assert.equal(MAX_NEW_PER_DAY, 2);

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("refresh detect self-test: pure parts passed; database part skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable database)");
} else {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { users, sites, ideas, jobs, posts, postPublications, searchConsoleMetrics } = await import("../../db/schema.js");
  const { detectRefreshIdeas } = await import("./detect.js");
  const { startIdea } = await import("../ideas/schedule.js");

  const [user, other] = await db.insert(users).values([
    { email: `refresh-${randomUUID()}@example.test`, passwordHash: "x" },
    { email: `refresh-${randomUUID()}@example.test`, passwordHash: "x" },
  ]).returning();
  try {
    const [site] = await db.insert(sites).values({ userId: user.id, name: "S", domain: "s.example.test" }).returning();
    const now = new Date();
    const win = windows(now);
    const DAY = 86_400_000;
    const mkPost = async (slug: string, ageDays: number) => {
      const [p] = await db.insert(posts).values({ userId: user.id, siteId: site.id, title: `Post ${slug}`, content: "c", sourceType: "article_title", modelId: "m" }).returning();
      await db.insert(postPublications).values({
        userId: user.id, postId: p.id, siteId: site.id, provider: "lindevo", status: "published", externalUrl: `https://s.example.test/blog/${slug}/`,
        publishedAt: new Date(now.getTime() - ageDays * DAY),
      });
      return p;
    };
    const metric = (slug: string, date: string, query: string, clicks: number, impressions: number, position: number) =>
      ({ userId: user.id, siteId: site.id, date, pageUrl: `https://s.example.test/blog/${slug}`, query, clicks, impressions, ctr: 0, position });
    const falling = await mkPost("falling", 120), striking = await mkPost("striking", 120), steady = await mkPost("steady", 120), young = await mkPost("young", 30), extra = await mkPost("extra", 120);
    await db.insert(searchConsoleMetrics).values([
      metric("falling", win.prevEnd, "solar roof", 20, 400, 4), metric("falling", win.curEnd, "solar roof", 8, 300, 4),
      metric("striking", win.curEnd, "solar battery cost", 3, 150, 11), metric("striking", win.curEnd, "battery payback", 1, 90, 13),
      metric("steady", win.prevEnd, "solar team", 20, 400, 3), metric("steady", win.curEnd, "solar team", 21, 400, 3),
      metric("young", win.prevEnd, "young", 20, 400, 3), metric("young", win.curEnd, "young", 2, 400, 3),
      metric("extra", win.curEnd, "extra", 1, 120, 15),
    ]);

    // two candidates a day, the declining one first; steady and young posts are left alone
    assert.equal(await detectRefreshIdeas(user.id, site.id, now), 2);
    const made = await db.select().from(ideas).where(and(eq(ideas.userId, user.id), eq(ideas.origin, "refresh")));
    assert.deepEqual(made.map((i) => i.refreshPostId).sort(), [falling.id, striking.id].sort());
    const fallingIdea = made.find((i) => i.refreshPostId === falling.id)!;
    assert.deepEqual([fallingIdea.status, fallingIdea.title, fallingIdea.refreshReason, fallingIdea.score], ["new", "Refresh: Post falling", "clicks −60% (28d)", null]);
    assert.equal(made.find((i) => i.refreshPostId === striking.id)!.refreshReason, "position 11.8, 240 impressions (28d)");
    assert.ok(![steady.id, young.id].some((id) => made.some((i) => i.refreshPostId === id)));
    assert.equal(await detectRefreshIdeas(user.id, site.id, now), 0, "the daily cap and the open ideas");
    assert.equal(await detectRefreshIdeas(other.id, site.id, now), 0, "another user sees nothing");

    // an open idea blocks; a decided one blocks for 28 days
    const old = new Date(now.getTime() - 40 * DAY);
    await db.update(ideas).set({ status: "rejected", createdAt: old, updatedAt: now }).where(and(eq(ideas.userId, user.id), eq(ideas.origin, "refresh")));
    assert.equal(await detectRefreshIdeas(user.id, site.id, now), 1, "only the third post is free: the other two are in their cooldown");
    assert.equal((await db.select().from(ideas).where(and(eq(ideas.userId, user.id), eq(ideas.refreshPostId, extra.id)))).length, 1);
    await db.delete(ideas).where(and(eq(ideas.userId, user.id), eq(ideas.refreshPostId, extra.id)));
    await db.update(ideas).set({ updatedAt: old }).where(and(eq(ideas.userId, user.id), eq(ideas.origin, "refresh")));
    assert.ok(await detectRefreshIdeas(user.id, site.id, now) >= 1, "after the cooldown it is a candidate again");

    // starting a refresh idea: the post's title, the angle, the post's searches, no cover, the post id
    const calls: any[] = [];
    const fakeRun = async (input: any) => { calls.push(input); const [job] = await db.insert(jobs).values({ userId: user.id, siteId: site.id, sourceType: "article_title", sourceValue: input.topic, modelId: "m" }).returning(); return { jobId: job.id, runId: randomUUID(), estimateUsd: 1 }; };
    const [again] = await db.select().from(ideas).where(and(eq(ideas.userId, user.id), eq(ideas.refreshPostId, falling.id), eq(ideas.status, "new")));
    assert.ok(again);
    assert.ok(await startIdea(user.id, site.id, again.id, fakeRun as never));
    assert.deepEqual([calls[0].topic, calls[0].refreshPostId, calls[0].cover, calls[0].guidance.angle], ["Post falling", falling.id, false, REFRESH_ANGLE]);
    assert.equal(calls[0].guidance.instructions, "Searches this post already appears for:\n- solar roof");
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  console.log("refresh detect self-test passed");
  process.exit(0);
}
console.log("refresh detect self-test (pure) passed");
