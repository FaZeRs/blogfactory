import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("post-translations routes self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { postTranslations, posts, sites, users } = await import("../db/schema.js");
  const { handleApiError } = await import("../http/error-contract.js");
  const { currentPostRevision, updatePostWithRevision } = await import("../services/post-revisions.js");
  const { postTranslationsRoutes } = await import("./post-translations.js");

  const mk = async () => (await db.insert(users).values({ email: `translations-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  const savedMode = process.env.BACKGROUND_EXECUTION_MODE;
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const [post] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Title", content: "Body.\n", sourceType: "article_title", modelId: "m" }).returning();
    const revision = (await currentPostRevision(owner.id, post.id))!;
    assert.ok(revision, "a new post has a first revision");
    const [row] = await db.insert(postTranslations).values({ userId: owner.id, siteId: site.id, postId: post.id, locale: "lv", title: "Nosaukums", slug: "nosaukums", description: "Apraksts", content: "Teksts.", status: "ready", sourceRevisionId: revision.id }).returning();

    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", postTranslationsRoutes).onError(handleApiError);
    const req = (method: string, path: string, body?: unknown, userId = owner.id) =>
      app(userId).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const edit = (extra: Record<string, unknown> = {}) => ({ title: "Jauns nosaukums", slug: "jauns-nosaukums", description: "Apraksts", content: "Jauns teksts.", imageAlt: "Attels", expectedUpdatedAt: row.updatedAt.toISOString(), ...extra });
    const path = `/${post.id}/translations`;

    // tenant scope: another user sees and changes nothing
    for (const [m, p, b] of [["GET", path, undefined], ["PUT", `${path}/lv`, edit()], ["POST", `${path}/lv/run`, {}]] as const) {
      assert.equal((await req(m, p, b, other.id)).status, 404, `${m} ${p}`);
    }
    assert.equal((await req("GET", `/${randomUUID()}/translations`)).status, 404);

    // read: fresh, not stale
    const list = async () => ((await (await req("GET", path)).json()) as any).translations;
    assert.deepEqual((await list()).map((t: any) => [t.locale, t.status, t.stale, t.title]), [["lv", "ready", false, "Nosaukums"]]);

    // validation, then the optimistic lock
    assert.equal((await req("PUT", `${path}/lv`, edit({ slug: "Not A Slug" }))).status, 400);
    assert.equal((await req("PUT", `${path}/lv`, edit({ title: "" }))).status, 400);
    assert.equal((await req("PUT", `${path}/lv`, edit({ expectedUpdatedAt: undefined }))).status, 400);
    assert.equal((await req("PUT", `${path}/xx-yy-zz`, edit())).status, 400);
    assert.equal((await req("PUT", `${path}/de`, edit())).status, 404);
    const stale = await req("PUT", `${path}/lv`, edit({ expectedUpdatedAt: new Date(row.updatedAt.getTime() - 1000).toISOString() }));
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as any).code, "conflict");

    // a good edit sets the status to edited and moves updatedAt
    const ok = await req("PUT", `${path}/lv`, edit());
    assert.equal(ok.status, 200);
    const saved = ((await ok.json()) as any).translation;
    assert.deepEqual([saved.status, saved.title, saved.stale], ["edited", "Jauns nosaukums", false]);
    assert.equal((await req("PUT", `${path}/lv`, edit())).status, 409, "the old version no longer saves");

    // a running translation cannot be edited, and a second run is refused
    await db.update(postTranslations).set({ status: "running", updatedAt: new Date() }).where(eq(postTranslations.id, row.id));
    const [running] = await db.select().from(postTranslations).where(eq(postTranslations.id, row.id));
    const blocked = await req("PUT", `${path}/lv`, edit({ expectedUpdatedAt: running!.updatedAt.toISOString() }));
    assert.equal(blocked.status, 409);
    assert.match(((await blocked.json()) as any).error ?? "", /running/i);
    delete process.env.BACKGROUND_EXECUTION_MODE;
    assert.equal((await req("POST", `${path}/lv/run`)).status, 400, "run needs the persistent worker");
    process.env.BACKGROUND_EXECUTION_MODE = "worker";
    process.env.ENGINE_AI_BASE_URL = "http://gateway.example.test/v1";
    assert.equal((await req("POST", `${path}/lv/run`)).status, 400, "locale not enabled for the site");
    delete process.env.ENGINE_AI_BASE_URL;

    // a new revision of the English makes the translation stale
    await db.update(postTranslations).set({ status: "ready" }).where(eq(postTranslations.id, row.id));
    const fresh = (await db.select().from(posts).where(eq(posts.id, post.id)))[0]!;
    await updatePostWithRevision({ userId: owner.id, postId: post.id, expectedUpdatedAt: fresh.updatedAt, source: "save", changes: { content: "Changed body.\n" } });
    assert.equal((await list())[0].stale, true);
  } finally {
    if (savedMode === undefined) delete process.env.BACKGROUND_EXECUTION_MODE;
    else process.env.BACKGROUND_EXECUTION_MODE = savedMode;
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  console.log("post-translations routes self-test passed");
  process.exit(0);
}
