import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("cover-routes self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = await import("hono");
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { imageAssets, posts, users } = await import("../db/schema.js");
  const { imagesRoutes } = await import("./images.js");

  const mk = async () => (await db.insert(users).values({ email: `cover-routes-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const app = (userId: string) => new Hono().use("*", async (c, next) => { c.set("userId" as never, userId as never); await next(); }).route("/", imagesRoutes);
    const post = (userId: string) => db.insert(posts).values({ userId, title: "t", content: "some content", sourceType: "article_keyword", modelId: "m" } as any).returning().then((r) => r[0]!);
    const [mine, theirs, bare] = [await post(owner.id), await post(other.id), await post(owner.id)];
    const asset = (p: typeof mine, userId: string, path: string, type = "cover") => db.insert(imageAssets).values({ userId, postId: p.id, storagePath: path, type, status: "used", sourceKind: "ai" } as any).returning().then((r) => r[0]!);
    const a1 = await asset(mine, owner.id, `covers/${randomUUID()}.webp`);
    const foreign = await asset(theirs, other.id, `covers/${randomUUID()}.webp`);
    const inline = await asset(mine, owner.id, `inline/${randomUUID()}.webp`, "inline");
    const req = (method: string, path: string, body?: unknown, userId = owner.id) =>
      app(userId).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    // tenant: another user's post is 404 on every route
    for (const [m, suffix, body] of [["GET", "covers", undefined], ["POST", "cover", {}], ["POST", "cover/adjust", { instruction: "make it blue" }], ["PUT", "cover", { asset_id: a1.id }]] as const) {
      assert.equal((await req(m, `/posts/${theirs.id}/${suffix}`, body)).status, 404, `${m} ${suffix} foreign post`);
    }

    // GET shape
    const got = await (await req("GET", `/posts/${mine.id}/covers`)).json() as any;
    assert.equal(got.cover, null);
    assert.equal(got.versions.length, 1);
    assert.equal(got.versions[0].id, a1.id);
    assert.equal(got.versions[0].url, `/api/storage/${a1.storagePath}`);
    assert.equal(got.default_preset, "site_default");
    assert.equal(got.presets.length, 6);
    assert.equal(typeof got.prompt_draft, "string");
    for (const preset of got.presets) assert.ok(got.prompt_drafts[preset.id]?.length > 0, `draft for ${preset.id}`);
    assert.equal(got.can_edit, false);

    // count / prompt validation
    for (const count of [0, 2, 4, "3"]) assert.equal((await req("POST", `/posts/${mine.id}/cover`, { count })).status, 400, `count ${count}`);
    assert.equal((await req("POST", `/posts/${mine.id}/cover`, { prompt: "short" })).status, 400);
    assert.equal((await req("POST", `/posts/${mine.id}/cover`, { preset: "nope" })).status, 400);
    const noModel = await req("POST", `/posts/${mine.id}/cover`, { count: 3 });
    assert.equal(noModel.status, 400);
    assert.equal(((await noModel.json()) as any).code, "image_model_missing");

    // adjust
    assert.equal((await req("POST", `/posts/${bare.id}/cover/adjust`, { instruction: "x" })).status, 400, "instruction too short");
    const noCover = await req("POST", `/posts/${bare.id}/cover/adjust`, { instruction: "make it blue" });
    assert.equal(noCover.status, 400);
    assert.equal(((await noCover.json()) as any).code, "cover_missing");

    // PUT
    assert.equal((await req("PUT", `/posts/${mine.id}/cover`, { asset_id: foreign.id })).status, 404, "another post's asset");
    assert.equal((await req("PUT", `/posts/${mine.id}/cover`, { asset_id: inline.id })).status, 404, "non-cover asset");
    assert.equal((await req("PUT", `/posts/${mine.id}/cover`, { asset_id: "nope" })).status, 404);
    const put = await req("PUT", `/posts/${mine.id}/cover`, { asset_id: a1.id });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { cover_image_url: a1.storagePath });
    const [after] = await db.select({ c: posts.coverImageUrl }).from(posts).where(eq(posts.id, mine.id));
    assert.equal(after!.c, a1.storagePath);
    console.log("cover-routes self-test ok");
  } finally {
    await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  }
  process.exit(0);
}
