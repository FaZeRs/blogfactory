import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { dbTestsEnabled } from "../test-db.js";

const enabled = dbTestsEnabled("deliver test");
const t = enabled ? await import("../test-db.js") : null;
const { db } = enabled ? await import("../../../db/index.js") : { db: null as never };
const schema = enabled ? await import("../../../db/schema.js") : ({} as never);
const { deliverStage } = await import("./index.js");

const postsOfRun = (userId: string, runId: string) =>
  db.select().from(schema.posts).where(and(eq(schema.posts.userId, userId), sql`${schema.posts.publishingMetadata}->'engine'->>'runId' = ${runId}`));

describe.skipIf(!enabled)("deliver (Review Focus 4)", () => {
  afterAll(() => t!.cleanup());

  test("a site that is gone before deliver fails the run cleanly and creates no post", async () => {
    const { run, site } = await t!.fixture("normal");
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const atDeliver = await t!.drive(run.id, deps, "deliver");
    expect(atDeliver.currentStage).toBe("deliver");
    // Deleting the site cascades to its runs, so the site is made unreachable for this user instead.
    const { user: other } = await t!.fixture("normal");
    await db.update(schema.sites).set({ userId: other.id }).where(eq(schema.sites.id, site.id));
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("failed");
    expect(end.stateReason).toBe("Site no longer exists");
    expect(end.postId).toBeNull();
    expect(await postsOfRun(run.userId, run.id)).toHaveLength(0);
  });

  test("delivering twice for one run creates one post with one revision", async () => {
    const { run } = await t!.fixture("normal");
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("done");
    const ctx = { run: end, deps, signal: new AbortController().signal, attempt: 2 };
    const again = await deliverStage.run(await deliverStage.input(ctx), ctx);
    expect(again.output).toEqual({ postId: end.postId!, created: false, escalated: false });
    const found = await postsOfRun(run.userId, run.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.editorialState).toBe("in_review");
    const revisions = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, found[0]!.id));
    expect(revisions).toHaveLength(1);
  });
});
