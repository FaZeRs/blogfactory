import assert from "node:assert/strict";
import { shouldApplyCover } from "./ai-image-queue.js";
import { openRouterImageRequestPayload } from "./generate-content.js";

assert.equal(shouldApplyCover("a.webp", "a.webp"), true, "unchanged cover is replaced");
assert.equal(shouldApplyCover("b.webp", "a.webp"), false, "a cover picked meanwhile is kept");
assert.equal(shouldApplyCover(null, null), true, "no cover before and after");
assert.equal(shouldApplyCover(null, ""), true, "empty marker means no cover at queue time");
assert.equal(shouldApplyCover("b.webp", null), false, "a cover set meanwhile beats a request queued without one");
assert.equal(shouldApplyCover(null, "a.webp"), false, "a removed cover is not restored");

const plain = openRouterImageRequestPayload("google/gemini-3.1-flash-image", "p", "1K", "16:9");
assert.equal("input_references" in plain, false, "no references by default");
const edit = openRouterImageRequestPayload("google/gemini-3.1-flash-image", "p", "1K", "16:9", ["data:image/webp;base64,AAAA"]);
assert.deepEqual(edit.input_references, [{ type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } }]);

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES === "1") {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { imageGenerationRequests, posts, users } = await import("../db/schema.js");
  const { queueDeferredImageRequest, processNextDeferredImage } = await import("./ai-image-queue.js");

  const [user] = await db.insert(users).values({ email: `cover-${randomUUID()}@example.test`, passwordHash: "x" }).returning();
  try {
    const [post] = await db.insert(posts).values({ userId: user!.id, title: "t", content: "c", sourceType: "article_keyword", modelId: "m" } as any).returning();
    const slot = { type: "cover" as const, position: 0, aspectRatio: "16:9", resolution: "1K", prompt: "a prompt", altText: "alt" };
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const r = await queueDeferredImageRequest({ userId: user!.id, postId: post!.id, jobId: null, imageModel: "google/gemini-3.1-flash-image", slot, force: true, replacesCover: i === 0 ? null : "x.webp", referencePath: i === 2 ? "x.webp" : null });
      assert.equal(r.created, true);
      ids.add(r.id!);
    }
    assert.equal(ids.size, 3, "force creates a new request each time");
    const rows = await db.select().from(imageGenerationRequests).where(eq(imageGenerationRequests.postId, post!.id));
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.replacesCover === "").length, 1, "null replacesCover stored as the no-cover marker");
    assert.equal(rows.filter((r) => r.referencePath === "x.webp").length, 1);

    // A request without a job is claimed and attempted (no key in the test user, so it requeues with an error).
    const result = await processNextDeferredImage(user!.id);
    assert.equal(result.status, "queued", "job-less request was claimed and attempted");
    assert.ok(result.error, "attempt failed on the missing key, not on missing job data");
    assert.ok(!/job/i.test(result.error!), result.error);
  } finally {
    await db.delete(users).where(eq(users.id, user!.id));
  }
}

console.log("ai-image-queue self-test passed");
