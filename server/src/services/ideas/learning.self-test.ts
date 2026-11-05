import assert from "node:assert/strict";
import { MAX_WEIGHT, MIN_SAMPLES, MIN_WEIGHT, nextWeights, pearson, type Sample } from "./learning.js";
import { DEFAULT_IDEA_SETTINGS, DEFAULT_WEIGHTS, normalizeIdeaSettings } from "./settings.js";

// pearson
assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6])! - 1) < 1e-9);
assert.ok(Math.abs(pearson([1, 2, 3], [6, 4, 2])! + 1) < 1e-9);
assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, "no variance");
assert.equal(pearson([1], [1]), null);

// nextWeights
const sample = (fit: number, outcome: number, trend = 0.5): Sample => ({ factors: { ...DEFAULT_WEIGHTS, trend, fit, demand: 0.5, feasibility: 0.5, novelty: 0.5, gain: 0.5 }, outcome });
const positive = [0.1, 0.3, 0.5, 0.7, 0.9].map((fit, i) => sample(fit, i));
const up = nextWeights(DEFAULT_WEIGHTS, positive);
assert.ok(Math.abs(up.fit - 1.1) < 1e-9, "a perfect correlation raises the weight by 10%");
assert.equal(up.trend, 1, "a factor with no variance keeps its weight");
const down = nextWeights(DEFAULT_WEIGHTS, [0.1, 0.3, 0.5, 0.7, 0.9].map((fit, i) => sample(fit, 5 - i)));
assert.ok(Math.abs(down.fit - 0.9) < 1e-9);
assert.deepEqual(nextWeights(DEFAULT_WEIGHTS, positive.slice(0, MIN_SAMPLES - 1)), DEFAULT_WEIGHTS, "too few samples");
assert.equal(nextWeights({ ...DEFAULT_WEIGHTS, fit: MAX_WEIGHT }, positive).fit, MAX_WEIGHT, "upper bound");
assert.equal(nextWeights({ ...DEFAULT_WEIGHTS, fit: MIN_WEIGHT }, [0.1, 0.3, 0.5, 0.7, 0.9].map((fit, i) => sample(fit, 5 - i))).fit, MIN_WEIGHT, "lower bound");
assert.equal(nextWeights({ ...DEFAULT_WEIGHTS, fit: 0 }, positive).fit, 0, "an ignored factor stays ignored");
assert.equal(nextWeights({ ...DEFAULT_WEIGHTS, fit: 1 / 3 }, positive).fit, Math.round((1 / 3) * 1.1 * 10_000) / 10_000, "rounded to 4 decimals");

// settings round trip keeps learning fields valid
const stored = normalizeIdeaSettings({ learnWeights: false, weightsLearnedMonth: "2026-11", weightHistory: [{ month: "2026-11", weights: { fit: 2 }, samples: 7 }, { month: "bad", samples: 1 }] });
assert.deepEqual([stored.learnWeights, stored.weightsLearnedMonth, stored.weightHistory.length, stored.weightHistory[0]!.weights.fit], [false, "2026-11", 1, 2]);
assert.equal(normalizeIdeaSettings({ weightHistory: Array.from({ length: 30 }, () => ({ month: "2026-01", weights: {}, samples: 1 })) }).weightHistory.length, 24);
assert.deepEqual(normalizeIdeaSettings(null).weightHistory, DEFAULT_IDEA_SETTINGS.weightHistory);

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ideas learning self-test: pure parts passed; database part skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable database)");
} else {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { users, sites, ideas, posts, postPublications, searchConsoleMetrics } = await import("../../db/schema.js");
  const { learnSiteWeights, drainWeightLearning } = await import("./learning.js");
  const { getIdeaSettings, saveIdeaSettings } = await import("./settings.js");
  const { bookOwnedIdea, listIdeas, rejectOwnedIdea, IdeaActionError } = await import("./actions.js");

  const [user, other] = await db.insert(users).values([
    { email: `learn-${randomUUID()}@example.test`, passwordHash: "x" },
    { email: `learn-${randomUUID()}@example.test`, passwordHash: "x" },
  ]).returning();
  try {
    const [site, site2] = await db.insert(sites).values([
      { userId: user.id, name: "S", domain: "s.example.test" }, { userId: user.id, name: "S2", domain: "s2.example.test" },
    ]).returning();
    const now = new Date();
    const day = (offset: number, from = now) => new Date(from.getTime() + offset * 86_400_000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const published = day(-70);
    const seo = (slug: string) => ({ version: 1, status: "ready", slug });
    const mkIdea = async (n: number, fit: number, clicks: number, over: { age?: number; siteId?: string } = {}) => {
      const pubAt = day(-(over.age ?? 70));
      const [post] = await db.insert(posts).values({ userId: user.id, siteId: site.id, title: `t${n}`, content: "c", sourceType: "article_title", modelId: "m", seoMetadata: seo(`post-${n}`) }).returning();
      await db.insert(postPublications).values({ userId: user.id, postId: post.id, siteId: site.id, provider: "x", status: "published", publishedAt: pubAt });
      await db.insert(ideas).values({
        userId: user.id, siteId: site.id, title: `idea ${n}`, status: "drafted", postId: post.id,
        scoreBreakdown: { trend: 0.5, fit, demand: 0.5, feasibility: 0.5, novelty: 0.5, gain: 0.5 },
      });
      if (clicks) await db.insert(searchConsoleMetrics).values({ userId: user.id, siteId: over.siteId ?? site.id, date: ymd(day(31, pubAt)), pageUrl: `https://s.example.test/blog/Post-${n}/`, query: "q", clicks });
      return post;
    };
    const fits = [0.2, 0.4, 0.6, 0.8, 0.95];
    const clicks = [0, 2, 9, 20, 100];
    for (let i = 0; i < 4; i++) await mkIdea(i, fits[i]!, clicks[i]!);
    // outside the window (day 10) and in another site: never counted
    await db.insert(searchConsoleMetrics).values([
      { userId: user.id, siteId: site.id, date: ymd(day(10, published)), pageUrl: "https://s.example.test/blog/post-0", query: "q", clicks: 5000 },
      { userId: user.id, siteId: site2.id, date: ymd(day(31, published)), pageUrl: "https://s2.example.test/blog/post-0", query: "q", clicks: 5000 },
    ]);
    await mkIdea(90, 0.5, 50, { age: 40 }); // window not complete yet

    assert.deepEqual(await learnSiteWeights(user.id, site.id, now), { status: "too_few_samples", samples: 4 }, "four complete samples and one too recent");
    assert.equal((await getIdeaSettings(user.id, site.id)).weightsLearnedMonth, null, "too few samples leaves the month open");
    await mkIdea(4, fits[4]!, clicks[4]!);
    assert.deepEqual(await learnSiteWeights(user.id, site.id, now), { status: "learned", samples: 5 });
    const learned = await getIdeaSettings(user.id, site.id);
    assert.ok(learned.weights.fit > 1 && learned.weights.fit <= 1.1, "clicks follow fit");
    assert.equal(learned.weights.trend, 1);
    assert.equal(learned.weightsLearnedMonth, now.toISOString().slice(0, 7));
    assert.deepEqual([learned.weightHistory.length, learned.weightHistory[0]!.samples], [1, 5]);
    assert.deepEqual(await learnSiteWeights(user.id, site.id, now), { status: "already_learned", samples: 0 }, "once per month");
    assert.equal((await getIdeaSettings(user.id, site.id)).weights.fit, learned.weights.fit);

    // the web save keeps learning's month and history
    await saveIdeaSettings(user.id, site.id, { ...learned, weightHistory: [], weightsLearnedMonth: null, weights: { ...learned.weights, gain: 2 } });
    const afterSave = await getIdeaSettings(user.id, site.id);
    assert.deepEqual([afterSave.weightHistory.length, afterSave.weightsLearnedMonth, afterSave.weights.gain], [1, learned.weightsLearnedMonth, 2]);

    // next month moves again; a frozen site does not; the drain covers sites with ideas and isolates failures
    const nextMonth = day(35);
    assert.equal((await learnSiteWeights(user.id, site.id, nextMonth)).status, "learned");
    assert.equal((await getIdeaSettings(user.id, site.id)).weightHistory.length, 2);
    await saveIdeaSettings(user.id, site.id, { ...afterSave, learnWeights: false });
    assert.equal((await learnSiteWeights(user.id, site.id, day(70))).status, "off");
    assert.equal((await drainWeightLearning(day(70))).failed, 0);

    // idea actions are user and site scoped
    const [inbox] = await db.insert(ideas).values({ userId: user.id, siteId: site.id, title: "inbox idea", status: "new", score: 80 }).returning();
    const notFound = (p: Promise<unknown>) => assert.rejects(p, (e: unknown) => e instanceof IdeaActionError && e.kind === "not_found");
    await notFound(rejectOwnedIdea({ userId: other.id, ideaId: inbox.id }));
    await notFound(bookOwnedIdea({ userId: user.id, ideaId: inbox.id, siteId: site2.id, action: "approve", body: {} }));
    assert.equal((await listIdeas({ userId: other.id, siteId: site.id })).length, 0);
    const listed = await listIdeas({ userId: user.id, siteId: site.id, statuses: ["new"], limit: 5 });
    assert.deepEqual(listed.map((r) => r.id), [inbox.id]);
    await assert.rejects(listIdeas({ userId: user.id, siteId: site.id, statuses: ["live"] }), IdeaActionError);
    const approved = await bookOwnedIdea({ userId: user.id, ideaId: inbox.id, siteId: site.id, action: "approve", body: { title: "Renamed idea title" } });
    assert.deepEqual([approved.status, approved.title], ["scheduled", "Renamed idea title"]);
    assert.ok(approved.scheduledFor);
    await assert.rejects(bookOwnedIdea({ userId: user.id, ideaId: inbox.id, action: "approve", body: {} }), (e: unknown) => e instanceof IdeaActionError && e.kind === "conflict");
    const rejected = await rejectOwnedIdea({ userId: user.id, ideaId: inbox.id, siteId: site.id, reason: "off topic" });
    assert.deepEqual([rejected.status, rejected.rejectedReason, rejected.scheduledFor], ["rejected", "off topic", null]);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  console.log("ideas learning self-test passed");
  process.exit(0);
}
console.log("ideas learning self-test (pure) passed");
