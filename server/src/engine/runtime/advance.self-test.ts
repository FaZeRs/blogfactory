import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("advance self-test skipped: set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a disposable DATABASE_URL");
  process.exit(0);
}
process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing to run against the shared blogfactory database");
delete process.env.ENGINE_AI_BASE_URL;

const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("../../db/index.js");
const { articleRuns, articleStageRuns, jobs, sites, users } = await import("../../db/schema.js");
const { claimArticleRuns } = await import("./claim.js");
const { advanceArticleRun } = await import("./advance.js");
const { loadEngineDeps } = await import("./deps.js");
const { RateLimitError } = await import("../types.js");
const { createFakeLlm } = await import("../adapters/fake-llm.js");
const { createFakeReader, createFakeSearch } = await import("../adapters/fakes.js");
type EngineDeps = import("./deps.js").EngineDeps;

const userIds: string[] = [];

async function fixture(over: { budgetUsd?: number; jobOwner?: string; topic?: string } = {}) {
  const [user] = await db.insert(users).values({ email: `engine-${randomUUID()}@example.test`, passwordHash: "x" }).returning();
  userIds.push(user.id);
  const [site] = await db.insert(sites).values({ userId: user.id, name: "t", domain: "t.example.test" }).returning();
  const [job] = await db.insert(jobs).values({
    userId: over.jobOwner ?? user.id, siteId: site.id, sourceType: "topic", sourceValue: "t", modelId: "m", status: "processing",
  }).returning();
  const [run] = await db.insert(articleRuns).values({
    userId: user.id, siteId: site.id, jobId: job.id, mode: "normal", sourceType: "topic", topic: over.topic ?? "topic",
    settings: {}, budgetUsd: over.budgetUsd ?? 1, nextAttemptAt: new Date(Date.now() - 1000),
  }).returning();
  return { user, site, job, run };
}

async function claimOne(runId: string, worker = "w1", at = new Date()) {
  const claimed = await claimArticleRuns(worker, 50, at);
  const mine = claimed.find((r) => r.id === runId);
  assert.ok(mine, "run was claimed");
  return mine;
}

const reload = async (id: string) => (await db.select().from(articleRuns).where(eq(articleRuns.id, id)))[0];
const stageRows = (runId: string) => db.select().from(articleStageRuns).where(eq(articleStageRuns.runId, runId));
const reloadJob = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

type Behaviour = { research?: () => Promise<void>; afterLlm?: () => Promise<void>; calls?: { n: number } };
function makeDeps(behaviour: Behaviour = {}, now: () => Date = () => new Date()) {
  const llm = createFakeLlm({ brief: Array.from({ length: 20 }, () => ({ a: "x" })) });
  const stage = (key: string, to?: string) => ({
    key,
    promptVersion: "v1",
    input: async (ctx: { run: { topic: string } }) => ({ topic: ctx.run.topic }),
    run: async (_input: unknown, ctx: { deps: EngineDeps }) => {
      if (behaviour.calls) behaviour.calls.n += 1;
      await behaviour.research?.();
      await ctx.deps.llm.json({ role: "brief", model: "m", system: "s", user: "u", schema: z.object({ a: z.string() }), maxTokens: 10 });
      await behaviour.afterLlm?.();
      return {
        output: { ok: true },
        next: to ? { type: "advance" as const, to } : { type: "done" as const },
        usage: [{ model: "m", promptTokens: 1, completionTokens: 2, costUsd: 0.01 }],
      };
    },
  });
  const deps = {
    llm, search: createFakeSearch({}), reader: createFakeReader({}), dataForSeo: null, now,
    stages: { research: stage("research", "brief"), brief: stage("brief", "draft"), draft: stage("draft", "gates"),
      gates: stage("gates", "deliver"), revise: stage("revise", "gates"), deliver: stage("deliver") },
  } as unknown as EngineDeps;
  return { deps, llm };
}

try {
  // Happy path + reuse.
  {
    const { run, job } = await fixture();
    const { deps, llm } = makeDeps();
    const claimed = await claimOne(run.id);
    assert.deepEqual(await advanceArticleRun(claimed, deps), { kind: "advanced", stage: "research" });
    const after = await reload(run.id);
    assert.equal(after.currentStage, "brief");
    assert.equal(after.version, 1);
    assert.equal(after.leaseOwner, null);
    assert.ok(Math.abs(after.spentUsd - 0.01) < 1e-9);
    const rows = await stageRows(run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "succeeded");
    assert.equal((await reloadJob(job.id)).currentStep, "engine_brief");
    assert.equal(llm.calls.length, 1);

    // Same input again: rewind the run to research and expect reuse with no model call.
    await db.update(articleRuns).set({ currentStage: "research", nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(articleRuns.id, run.id));
    const again = await claimOne(run.id);
    assert.deepEqual(await advanceArticleRun(again, deps), { kind: "reused", stage: "research" });
    assert.equal(llm.calls.length, 1);
    assert.deepEqual((await stageRows(run.id)).map((r) => r.status).sort(), ["reused", "succeeded"]);
    assert.equal((await reload(run.id)).currentStage, "brief");
    assert.ok(Math.abs((await reload(run.id)).spentUsd - 0.01) < 1e-9, "reuse costs nothing");
  }

  // Review Focus 3: racing claims are disjoint.
  {
    const fixtures = await Promise.all([fixture(), fixture(), fixture(), fixture()]);
    const ids = new Set(fixtures.map((f) => f.run.id));
    const [a, b] = await Promise.all([claimArticleRuns("wa", 2, new Date()), claimArticleRuns("wb", 2, new Date())]);
    const mineA = a.filter((r) => ids.has(r.id)).map((r) => r.id);
    const mineB = b.filter((r) => ids.has(r.id)).map((r) => r.id);
    assert.equal(mineA.filter((id) => mineB.includes(id)).length, 0, "no run claimed twice");
    assert.ok(a.every((r) => r.leaseOwner === "wa") && b.every((r) => r.leaseOwner === "wb"));
    // A live lease blocks a third claim of the same runs.
    const third = await claimArticleRuns("wc", 50, new Date());
    assert.equal(third.filter((r) => [...mineA, ...mineB].includes(r.id)).length, 0);
    // An expired lease can be taken over.
    const later = await claimArticleRuns("wc", 50, new Date(Date.now() + 21 * 60_000));
    assert.ok(later.some((r) => [...mineA, ...mineB].includes(r.id)));
  }

  // A version change or a stolen lease before commit: lease_lost, run untouched, no job mirror.
  for (const steal of ["version", "owner"] as const) {
    const { run, job } = await fixture();
    const claimed = await claimOne(run.id);
    const { deps } = makeDeps({
      research: async () => {
        await db.update(articleRuns).set(steal === "version" ? { version: 5 } : { leaseOwner: "someone-else" }).where(eq(articleRuns.id, run.id));
      },
    });
    assert.deepEqual(await advanceArticleRun(claimed, deps), { kind: "lease_lost", stage: "research" });
    const after = await reload(run.id);
    assert.equal(after.currentStage, "research");
    assert.equal(after.version, steal === "version" ? 5 : 0);
    assert.equal(after.spentUsd, 0);
    assert.equal(after.state, "active");
    const rows = await stageRows(run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].error, "lease lost");
    assert.equal((await reloadJob(job.id)).currentStep, "queued");
  }

  // 429: no attempt consumed, rescheduled at least 60 s out; two failures + 429 + success still advances.
  {
    const { run } = await fixture();
    let t = new Date();
    const script: Array<"fail" | "rate" | "ok"> = ["fail", "fail", "rate", "ok"];
    const { deps } = makeDeps({
      research: async () => {
        const step = script.shift();
        if (step === "fail") throw new Error("boom");
        if (step === "rate") throw new RateLimitError("slow down", 1000);
      },
    }, () => t);
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      t = new Date(t.getTime() + 2 * 3600_000);
      const claimed = await claimOne(run.id, "w1", t);
      const res = await advanceArticleRun(claimed, deps);
      kinds.push(res.kind);
      const state = await reload(run.id);
      if (res.kind === "retry") assert.equal(state.nextAttemptAt.getTime(), t.getTime() + (kinds.length === 1 ? 10 : 30) * 60_000);
      if (res.kind === "rate_limited") {
        assert.ok(state.nextAttemptAt.getTime() >= t.getTime() + 60_000);
        assert.equal(state.state, "active");
        assert.equal((await stageRows(run.id)).filter((r) => r.status === "running").length, 0);
      }
    }
    assert.deepEqual(kinds, ["retry", "retry", "rate_limited", "advanced"]);
  }

  // Three thrown errors fail the run and the job.
  {
    const { run, job } = await fixture();
    let t = new Date();
    const { deps } = makeDeps({ research: async () => { throw new Error("x".repeat(500)); } }, () => t);
    const kinds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      t = new Date(t.getTime() + 2 * 3600_000);
      kinds.push((await advanceArticleRun(await claimOne(run.id, "w1", t), deps)).kind);
    }
    assert.deepEqual(kinds, ["retry", "retry", "failed"]);
    const after = await reload(run.id);
    assert.equal(after.state, "failed");
    assert.equal(after.stateReason?.length, 300);
    const j = await reloadJob(job.id);
    assert.equal(j.status, "failed");
    assert.equal(j.errorMessage, after.stateReason);
    assert.ok(j.completedAt);
  }

  // A failed attempt still counts the model spend it made.
  {
    const { run } = await fixture();
    const { deps } = makeDeps({ afterLlm: async () => { throw new Error("boom"); } });
    const priced = { ...deps, llm: { json: async (req: never) => ({ ...(await deps.llm.json(req)), costUsd: 0.02 }) } } as EngineDeps;
    assert.equal((await advanceArticleRun(await claimOne(run.id), priced)).kind, "retry");
    assert.ok(Math.abs((await reload(run.id)).spentUsd - 0.02) < 1e-9);
    const [failed] = await stageRows(run.id);
    assert.ok(Math.abs(failed.costUsd - 0.02) < 1e-9);
  }

  // Budget: nothing is called.
  {
    const { run } = await fixture({ budgetUsd: 0.01 });
    const calls = { n: 0 };
    const { deps, llm } = makeDeps({ calls });
    const now = new Date();
    const res = await advanceArticleRun(await claimOne(run.id), { ...deps, now: () => now });
    assert.equal(res.kind, "failed");
    assert.equal(calls.n, 0);
    assert.equal(llm.calls.length, 0);
    const after = await reload(run.id);
    assert.equal(after.state, "failed");
    assert.match(after.stateReason ?? "", /^Run budget reached: \$0\.00 of \$0\.01 spent$/);
    assert.equal((await stageRows(run.id)).length, 0);
  }

  // Terminal done mirrors the job; a deliver-style stage that set post_id completes it.
  {
    const { run, job } = await fixture();
    const { deps } = makeDeps();
    await db.update(articleRuns).set({ currentStage: "deliver" }).where(eq(articleRuns.id, run.id));
    assert.equal((await advanceArticleRun(await claimOne(run.id), deps)).kind, "done");
    const j = await reloadJob(job.id);
    assert.equal(j.status, "failed", "done without a post is not a completed job");
    assert.equal((await reload(run.id)).state, "done");
  }

  // Tenant isolation.
  {
    const a = await fixture();
    const b = await fixture();
    // B's run points at A's job.
    await db.update(articleRuns).set({ jobId: a.job.id }).where(eq(articleRuns.id, b.run.id));
    const { deps } = makeDeps();
    const claimed = await claimOne(b.run.id);
    assert.equal((await advanceArticleRun(claimed, deps)).kind, "failed");
    const bAfter = await reload(b.run.id);
    assert.equal(bAfter.state, "failed");
    assert.equal(bAfter.currentStage, "research");
    assert.equal((await reloadJob(a.job.id)).currentStep, "queued", "A's job untouched");
    assert.equal((await stageRows(b.run.id)).length, 0);
    // Deps are built from the run's own user: A has no OpenRouter key.
    await assert.rejects(loadEngineDeps(a.run), /OpenRouter is not configured/);
    // A guarded write scoped to the wrong user changes nothing.
    const wrong = await db.update(articleRuns).set({ stateReason: "hijack" })
      .where(and(eq(articleRuns.id, a.run.id), eq(articleRuns.userId, b.user.id))).returning();
    assert.equal(wrong.length, 0);
  }
} finally {
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
}

console.log("article run runtime self-check passed");
process.exit(0);
