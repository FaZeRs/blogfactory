import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("ai-visibility routes self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { sites, users } = await import("../db/schema.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { createAiVisibilityRoutes, searchModels } = await import("./ai-visibility.js");

  const mk = async () => (await db.insert(users).values({ email: `aivis-routes-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "Acme", domain: "acme.example.test" }).returning();
    const routes = createAiVisibilityRoutes();
    assert.deepEqual(searchModels([
      { id: "openai/gpt-5.6", name: "GPT", rawPricing: { webSearch: 0.01 } },
      { id: "openai/gpt-5.6:batch", name: "GPT batch", rawPricing: { webSearch: 0.01 } },
      { id: "meta/llama", name: "Llama", rawPricing: { webSearch: 0.01 } },
      { id: "perplexity/sonar", name: "Sonar", rawPricing: { webSearch: 0 } },
    ]), [{ id: "openai/gpt-5.6", label: "GPT", searchPrice: 0.01 }]);
    const req = (method: string, path: string, body?: unknown, userId = owner.id) =>
      new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", routes).onError(handleApiError)
        .request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    // tenant: another user's site is 404 on every route that takes a site
    for (const [m, path, body] of [
      ["GET", `/?siteId=${site.id}`, undefined], ["PUT", "/settings", { siteId: site.id, settings: {} }], ["POST", "/suggest", { siteId: site.id }],
      ["POST", "/run", { siteId: site.id }], ["POST", "/gap-idea", { siteId: site.id, question: "How do I pick a CRM?" }],
    ] as const) assert.equal((await req(m, path, body, other.id)).status, 404, `${m} ${path}`);
    assert.equal((await req("GET", "/")).status, 400);

    // read: no key, no gateway
    delete process.env.ENGINE_AI_BASE_URL;
    const read = await (await req("GET", `/?siteId=${site.id}`)).json() as any;
    assert.deepEqual([read.available, read.reason, read.running, read.settings.questions], [false, "no_openrouter_key", false, []]);
    assert.equal(read.summary.week, null);
    process.env.ENGINE_AI_BASE_URL = "http://gateway.example.test/v1";
    try { assert.equal(((await (await req("GET", `/?siteId=${site.id}`)).json()) as any).reason, "custom_gateway"); } finally { delete process.env.ENGINE_AI_BASE_URL; }

    // settings: validation failure is 400 with the indexes; bad engines are 400; a good save round-trips
    const bad = await req("PUT", "/settings", { siteId: site.id, settings: { questions: ["Why is Acme great?", "How do I pick a CRM?"] } });
    assert.equal(bad.status, 400);
    const badBody = await bad.json() as any;
    assert.deepEqual(badBody.errors.map((e: any) => e.index), [0]);
    assert.ok(badBody.error);
    assert.equal((await req("PUT", "/settings", { siteId: site.id, settings: { engines: ["not an id"] } })).status, 400);
    assert.equal((await req("PUT", "/settings", { siteId: site.id })).status, 400);
    const saved = await req("PUT", "/settings", { siteId: site.id, settings: { enabled: true, questions: ["How do I pick a CRM"], engines: ["openai/gpt-5.6"] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as any).settings.questions, ["How do I pick a CRM?"]);

    // run: no OpenRouter key is a 400
    assert.equal((await req("POST", "/run", { siteId: site.id })).status, 400);
    // models: no key is a 400 (the cached helper is only reached with a key)
    assert.equal((await req("GET", "/models")).status, 400);
    // gap-idea: too short is 400
    assert.equal((await req("POST", "/gap-idea", { siteId: site.id, question: "no" })).status, 400);
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  console.log("ai-visibility routes self-test passed");
  process.exit(0);
}
