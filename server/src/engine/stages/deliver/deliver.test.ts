import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { staleSourceRevisions } from "../../../services/localization/stale.js";
import { currentPostRevision, setPostEditorialState, updatePostWithRevision } from "../../../services/post-revisions.js";
import { dbTestsEnabled } from "../test-db.js";

const enabled = dbTestsEnabled("deliver test");
const t = enabled ? await import("../test-db.js") : null;
const { db } = enabled ? await import("../../../db/index.js") : { db: null as never };
const schema = enabled ? await import("../../../db/schema.js") : ({} as never);
const { EDITED_WHILE_REFRESHING, deliverStage, modelDisplayName } = await import("./index.js");

test("model display names: OpenRouter ids and subscription ids read the same", () => {
  expect(modelDisplayName("anthropic/claude-sonnet-5.5")).toBe("Claude Sonnet 5.5");
  expect(modelDisplayName("claude-code:claude-opus-5-5|anthropic/claude-opus-5.5")).toBe("Claude Opus 5.5");
  expect(modelDisplayName("claude-code:claude-opus-5-5")).toBe("Claude Opus 5.5");
});

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

  /** A published post with a translation and a CMS publication, and a run set to refresh it. */
  async function refreshFixture() {
    const f = await t!.fixture("normal");
    const [post] = await db.insert(schema.posts).values({
      userId: f.user.id, siteId: f.site.id, title: "Old title", content: "Old body of the post.", status: "draft", sourceType: "article_title", modelId: "m", jobId: f.job.id,
      seoMetadata: { version: 1, status: "ready", slug: "solar-for-small-teams", provenance: { slug: "ai" } },
    }).returning();
    const rev1 = await currentPostRevision(f.user.id, post!.id);
    await setPostEditorialState({ userId: f.user.id, postId: post!.id, state: "approved", expectedRevisionId: rev1!.id });
    const [publication] = await db.insert(schema.postPublications).values({
      userId: f.user.id, postId: post!.id, siteId: f.site.id, provider: "lindevo", status: "draft", externalId: "ext-1",
    }).returning();
    const [translation] = await db.insert(schema.postTranslations).values({
      userId: f.user.id, siteId: f.site.id, postId: post!.id, locale: "lv", title: "Vecs", content: "Vecs teksts", status: "ready", sourceRevisionId: rev1!.id,
    }).returning();
    await db.update(schema.articleRuns).set({ settings: { refreshPostId: post!.id } }).where(eq(schema.articleRuns.id, f.run.id));
    return { ...f, post: post!, rev1: rev1!, publication: publication!, translation: translation! };
  }

  test("a refresh run writes a new revision of the same post, back in review, and leaves the translation stale", async () => {
    const f = await refreshFixture();
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(f.run.id, deps);
    expect(end.state).toBe("done");
    expect(end.postId).toBe(f.post.id);

    expect(await db.select().from(schema.posts).where(eq(schema.posts.userId, f.user.id))).toHaveLength(1);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, f.post.id));
    expect(post!.title).toBe("Solar for small teams, explained");
    expect(post!.content).toContain("Section number 3");
    expect(post!.editorialState).toBe("in_review");
    // The slug is pinned so the SEO step cannot replace the published URL.
    expect((post!.seoMetadata as { slug: string; provenance: { slug: string } }).slug).toBe("solar-for-small-teams");
    expect((post!.seoMetadata as { provenance: { slug: string } }).provenance.slug).toBe("manual");

    const revisions = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, f.post.id)).orderBy(schema.postRevisions.revisionNumber);
    expect(revisions[0]!.source).toBe("initial");
    expect(revisions.at(-1)!.source).toBe("refresh");
    expect(revisions).toHaveLength(2);

    const [publication] = await db.select().from(schema.postPublications).where(eq(schema.postPublications.id, f.publication.id));
    expect(publication).toMatchObject({ postId: f.post.id, externalId: "ext-1", status: "draft" });

    const current = await currentPostRevision(f.user.id, f.post.id);
    const stale = await staleSourceRevisions(f.user.id, [f.translation.sourceRevisionId], current);
    expect(stale.has(f.rev1.id)).toBe(true);
    const output = (await db.select().from(schema.articleStageRuns).where(eq(schema.articleStageRuns.runId, f.run.id))).find((r) => r.stage === "deliver")!.output as { output: { created: boolean; refreshed: boolean; note: string | null } };
    expect(output.output).toMatchObject({ created: false, refreshed: true, note: null });
  });

  test("a refresh notes when the post was edited while it was being refreshed, and still writes the revision", async () => {
    const f = await refreshFixture();
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const atDeliver = await t!.drive(f.run.id, deps, "deliver");
    await updatePostWithRevision({ userId: f.user.id, postId: f.post.id, expectedUpdatedAt: (await db.select().from(schema.posts).where(eq(schema.posts.id, f.post.id)))[0]!.updatedAt, source: "save", changes: { content: "A person edited this." } });
    const end = await t!.drive(atDeliver.id, deps);
    expect(end.state).toBe("done");
    const output = (await db.select().from(schema.articleStageRuns).where(eq(schema.articleStageRuns.runId, f.run.id))).find((r) => r.stage === "deliver")!.output as { output: { note: string } };
    expect(output.output.note).toBe(EDITED_WHILE_REFRESHING);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, f.post.id));
    expect(post!.content).toContain("Section number 3");
  });

  test("a refresh run whose post is gone fails and creates no post", async () => {
    const f = await refreshFixture();
    await db.update(schema.articleRuns).set({ settings: { refreshPostId: randomUUID() } }).where(eq(schema.articleRuns.id, f.run.id));
    const { deps } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(f.run.id, deps);
    expect(end.state).toBe("failed");
    expect(await db.select().from(schema.posts).where(eq(schema.posts.userId, f.user.id))).toHaveLength(1);
  });
});
