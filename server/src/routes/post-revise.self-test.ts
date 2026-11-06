import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("post revise route self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { articleEvidence, articleRuns, articleSources, generationLogs, operationEvents, postRevisions, posts, sites, users } = await import("../db/schema.js");
  const { createFakeLlm } = await import("../engine/adapters/fake-llm.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { createPostReviseRoutes } = await import("./post-revise.js");

  const mk = async () => (await db.insert(users).values({ email: `revise-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const [post] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Original title here", content: "Old body.\n", sourceType: "article_title", modelId: "m", summary: "Original description of the post." }).returning();
    const [run] = await db.insert(articleRuns).values({ userId: owner.id, siteId: site.id, postId: post.id, mode: "normal", sourceType: "article_title", topic: "t", settings: {}, budgetUsd: 1 }).returning();
    const [source] = await db.insert(articleSources).values({ runId: run.id, userId: owner.id, url: "https://src.example.test/a" }).returning();
    await db.insert(articleEvidence).values([
      { runId: run.id, userId: owner.id, sourceId: source.id, claim: "Verified claim", quote: "verified quote", verified: true },
      { runId: run.id, userId: owner.id, sourceId: source.id, claim: "Unverified claim", quote: "unverified quote", verified: false },
    ]);

    const newBody = `${"New paragraph with the owner's change applied.\n\n".repeat(8)}`;
    const reply = { title: "Revised title here", description: "A revised description that is long enough.", markdown: newBody };
    const fake = createFakeLlm({ revise: [reply, reply] });
    // A priced reply, so the spend log can be checked.
    const llm = { json: async (req: any) => ({ ...(await fake.json(req)), costUsd: 0.01 }) };
    const routes = createPostReviseRoutes({ reviseDeps: { llm, model: "test/model" } });
    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", routes).onError(handleApiError);
    const req = (id: string, body: unknown, userId = owner.id) =>
      app(userId).request(`/${id}/revise-with-comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const comments = "Make the intro shorter and add an example.";

    // validation, tenant scope and the version check all come before any model call
    assert.equal((await req(post.id, { comments: "short", expectedUpdatedAt: post.updatedAt })).status, 400);
    assert.equal((await req(post.id, { comments })).status, 400);
    assert.equal((await req(post.id, { comments, expectedUpdatedAt: post.updatedAt }, other.id)).status, 404);
    assert.equal((await req(randomUUID(), { comments, expectedUpdatedAt: post.updatedAt })).status, 404);
    const stale = await req(post.id, { comments, expectedUpdatedAt: new Date(post.updatedAt.getTime() - 1000).toISOString() });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as any).code, "conflict");
    assert.equal(fake.calls.length, 0, "no model call for a refused request");

    const ok = await req(post.id, { comments, expectedUpdatedAt: post.updatedAt.toISOString() });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as any;
    assert.deepEqual([saved.title, saved.summary, saved.changed], ["Revised title here", reply.description, true]);
    assert.ok(saved.content.includes("owner's change"));
    assert.ok(saved.current_revision.revision_number >= 2 || saved.current_revision.revisionNumber >= 2);
    assert.equal((await db.select().from(postRevisions).where(eq(postRevisions.postId, post.id))).length, 2);

    // the run's verified evidence and the comments reach the prompt; unverified evidence does not
    const user = fake.calls[0]!.user;
    assert.ok(user.includes("verified quote") && !user.includes("unverified quote") && user.includes(comments) && user.includes("Old body."));
    assert.equal(fake.calls[0]!.role, "revise");

    // the old version is now stale
    assert.equal((await req(post.id, { comments, expectedUpdatedAt: post.updatedAt.toISOString() })).status, 409);

    // spend and a text-free operation event
    const logs = await db.select().from(generationLogs).where(eq(generationLogs.postId, post.id));
    // the follow-up SEO drain logs its own row
    assert.deepEqual(logs.filter((l) => (l.responseData as any)?.reviseWithComments).map((l) => [l.userId, l.cost, l.status]), [[owner.id, 0.01, "success"]]);
    const [event] = await db.select().from(operationEvents).where(eq(operationEvents.objectId, post.id));
    assert.deepEqual([event.action, event.status], ["posts.revise_comments", "succeeded"]);
    assert.ok(!JSON.stringify(event).includes(comments) && !JSON.stringify(event).includes("owner's change"));
    console.log("post revise route self-test ok");
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  process.exit(0);
}
