import assert from "node:assert/strict";
import { engineAvailability, engineSettingsResponse } from "./article-runs.js";
import { safeOperationMetadata } from "../services/operation-events.js";

assert.deepEqual(engineAvailability({}), {
  available: false, reason: "worker_required",
  adapters: { searxng: false, crawl4ai: false, dataforseo: false, gateway: "openrouter" },
});
assert.deepEqual(engineAvailability({ BACKGROUND_EXECUTION_MODE: "worker" }), {
  available: true, reason: null,
  adapters: { searxng: false, crawl4ai: false, dataforseo: false, gateway: "openrouter" },
});
const custom = engineAvailability({ BACKGROUND_EXECUTION_MODE: "worker", ENGINE_AI_BASE_URL: "http://x", SEARXNG_URL: "http://s", DATAFORSEO_LOGIN: "a" });
assert.equal(custom.adapters.gateway, "custom");
assert.equal(custom.adapters.searxng, true);
assert.equal(custom.adapters.dataforseo, false, "needs login and password");
assert.equal(custom.available, false, "a custom gateway needs its API key");
assert.deepEqual(
  { ...engineAvailability({ BACKGROUND_EXECUTION_MODE: "worker" }, false), adapters: undefined },
  { available: false, reason: "ai_key_missing", adapters: undefined },
  "no OpenRouter key means the engine is not ready",
);

assert.deepEqual(
  safeOperationMetadata("engine.stage", { prompt: "x", quote: "y", stage: "draft", run_id: "r", mode: "normal", status: "advanced", cost_usd: 0.1, duration_ms: 5, source_value: "s" }),
  { run_id: "r", stage: "draft", mode: "normal", status: "advanced", cost_usd: 0.1, duration_ms: 5 },
);

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES === "1") {
  process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory_engine_test";
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL), "refusing the shared database");
  delete process.env.BACKGROUND_EXECUTION_MODE;
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { users, sites, jobs, articleRuns } = await import("../db/schema.js");
  const { startArticleRun, getArticleRunForJob, EngineUnavailableError } = await import("./article-runs.js");
  const [user] = await db.insert(users).values({ email: `ar-${randomUUID()}@example.test`, passwordHash: "x" }).returning();
  try {
    const [site] = await db.insert(sites).values({ userId: user.id, name: "t", domain: "t.example.test" }).returning();
    const input = { userId: user.id, siteId: site.id, mode: "normal" as const, sourceType: "article_keyword" as const, topic: "k", origin: "web" as const };
    await assert.rejects(startArticleRun(input), (e: any) => e instanceof EngineUnavailableError && e.code === "worker_required");
    process.env.BACKGROUND_EXECUTION_MODE = "worker";
    delete process.env.ENGINE_AI_BASE_URL;
    await assert.rejects(startArticleRun(input), (e: any) => e instanceof EngineUnavailableError && e.code === "ai_key_missing");
    process.env.ENGINE_AI_BASE_URL = "http://llm.example.test/v1";
    process.env.ENGINE_AI_API_KEY = "k";
    const started = await startArticleRun(input);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, started.jobId));
    assert.equal(job.status, "running");
    assert.equal(job.currentStep, "engine_research");
    const [run] = await db.select().from(articleRuns).where(eq(articleRuns.id, started.runId));
    assert.equal(run.jobId, job.id);
    assert.equal((run.settings as any).models.draft, "anthropic/claude-sonnet-5.5", "custom gateway keeps ids as given");
    assert.equal((run.settings as any).destinationProvider, null, "no destination, no provider");
    const { siteIntegrations } = await import("../db/schema.js");
    const [integration] = await db.insert(siteIntegrations).values({ userId: user.id, siteId: site.id, provider: "lindevo", displayName: "L", credentialsEncrypted: "x" }).returning();
    for (const preferredIntegrationId of [undefined, integration.id]) {
      const again = await startArticleRun({ ...input, preferredIntegrationId });
      const [r] = await db.select().from(articleRuns).where(eq(articleRuns.id, again.runId));
      assert.equal((r.settings as any).destinationProvider, "lindevo", "frozen from the only or preferred connected destination");
    }
    assert.equal((await getArticleRunForJob(user.id, started.jobId))?.stages.length, 0);
    assert.equal(await getArticleRunForJob(randomUUID(), started.jobId), null, "other users see nothing");
    // Key vanishes after the run started: one drain fails the run and its job with the reason.
    delete process.env.ENGINE_AI_BASE_URL;
    const { drainArticleRuns } = await import("./article-runs.js");
    assert.ok((await drainArticleRuns(50, "w-test")) >= 1);
    const [failed] = await db.select().from(articleRuns).where(eq(articleRuns.id, started.runId));
    assert.equal(failed.state, "failed");
    assert.equal(failed.stateReason, "OpenRouter is not configured");
    assert.equal(failed.leaseOwner, null);
    const [failedJob] = await db.select().from(jobs).where(eq(jobs.id, started.jobId));
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.errorMessage, "OpenRouter is not configured");
    await assert.rejects(startArticleRun({ ...input, siteId: randomUUID() }), /Site not found/);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
}
console.log("article runs self-test passed");
process.exit(0);

const resp = engineSettingsResponse({ budgetUsd: 3, citationStyle: "inline", junk: 1 }, {});
assert.deepEqual(resp.settings, { budgetUsd: 3, citationStyle: "inline" });
assert.equal(resp.availability.available, false);
assert.ok(resp.estimates.deep > resp.estimates.normal);
assert.deepEqual(engineSettingsResponse("bad", {}).settings, {});
