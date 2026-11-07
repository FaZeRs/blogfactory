import assert from "node:assert/strict";
import { fitShareKit } from "../services/share-kit.js";

// Pure: lengths are fitted and a pull quote must be word for word in the article (markup and quote marks aside).
const article = "## Costs\n\nA **self-hosted** setup costs about 20 euros a month on a small server.\n\nCloud plans start higher but need no upkeep.";
const fitted = fitShareKit({
  linkedin: "  Plain post.  ",
  thread: ["one", "", "x".repeat(400), "three", "four", "five", "six", "seven"],
  newsletter: "Blurb.",
  quotes: ["A self-hosted setup costs about 20 euros a month on a small server.", "An invented quote that the article never said at all.", "A self-hosted setup costs about 20 euros a month on a small server."],
  teaser: "t".repeat(300),
}, article);
assert.equal(fitted.linkedin, "Plain post.");
assert.equal(fitted.thread.length, 6);
assert.ok(fitted.thread.every((p) => p.length <= 280 && p.length > 0));
assert.deepEqual(fitted.quotes, ["A self-hosted setup costs about 20 euros a month on a small server."]);
assert.ok(fitted.teaser.length <= 200);

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("share kit route self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { generationLogs, postShareKits, posts, sites, users } = await import("../db/schema.js");
  const { createFakeLlm } = await import("../engine/adapters/fake-llm.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { createShareKitRoutes } = await import("./share-kit.js");

  const mk = async () => (await db.insert(users).values({ email: `share-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const body = `${article}\n\n${"More words about running it yourself and what that takes each month. ".repeat(6)}`;
    const [post] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Self-hosting costs", content: body, sourceType: "article_title", modelId: "m" }).returning();
    const [short] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Tiny", content: "Too short.", sourceType: "article_title", modelId: "m" }).returning();

    const reply = { linkedin: "A post.", thread: ["First.", "Second.", "Third."], newsletter: "Blurb.", quotes: ["Cloud plans start higher but need no upkeep."], teaser: "Teaser." };
    const fake = createFakeLlm({ brief: [reply, reply] });
    const llm = { json: async (req: any) => ({ ...(await fake.json(req)), costUsd: 0.01 }) };
    const routes = createShareKitRoutes({ shareKitDeps: { llm, model: "test/model" } });
    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", routes).onError(handleApiError);
    const call = (method: string, id: string, userId = owner.id) => app(userId).request(`/${id}/share-kit`, { method });

    // tenant scope and the length check come before any model call
    assert.equal((await call("POST", post.id, other.id)).status, 404);
    assert.equal((await call("GET", post.id, other.id)).status, 404);
    assert.equal((await call("POST", short.id)).status, 400);
    assert.equal(fake.calls.length, 0, "no model call for a refused request");
    assert.deepEqual(await (await call("GET", post.id)).json(), { share_kit: null });

    const res = await call("POST", post.id);
    const made = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(made));
    assert.deepEqual(made.share_kit.kit.quotes, ["Cloud plans start higher but need no upkeep."]);
    assert.equal(made.share_kit.stale, false);
    assert.ok(fake.calls[0]!.user.includes("Self-hosting costs") && fake.calls[0]!.user.includes("20 euros"));

    // a second kit replaces the first; an edit makes it stale
    await call("POST", post.id);
    assert.equal((await db.select().from(postShareKits).where(eq(postShareKits.postId, post.id))).length, 1);
    await db.update(posts).set({ content: `${body}\n\nA new paragraph.` }).where(eq(posts.id, post.id));
    const after = (await (await call("GET", post.id)).json()) as any;
    assert.equal(after.share_kit.stale, true);

    const logs = await db.select().from(generationLogs).where(eq(generationLogs.postId, post.id));
    assert.deepEqual(logs.map((l) => [l.userId, l.cost, l.status, (l.responseData as any)?.shareKit]), [[owner.id, 0.01, "success", true], [owner.id, 0.01, "success", true]]);
    console.log("share kit route self-test ok");
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  process.exit(0);
}
