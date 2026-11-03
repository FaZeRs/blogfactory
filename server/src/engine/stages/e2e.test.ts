import { afterAll, describe, expect, test } from "bun:test";
import { dbTestsEnabled } from "./test-db.js";

const enabled = dbTestsEnabled("engine e2e test");
const t = await (enabled ? import("./test-db.js") : Promise.resolve(null));
const { db } = enabled ? await import("../../db/index.js") : { db: null as never };
const { articleStageRuns, posts } = enabled ? await import("../../db/schema.js") : ({} as never);
const { eq } = await import("drizzle-orm");

describe.skipIf(!enabled)("engine end to end (fakes only)", () => {
  afterAll(() => t!.cleanup());

  const postOf = async (id: string | null) => (await db.select().from(posts).where(eq(posts.id, id!)))[0]!;
  const stages = async (runId: string) => (await db.select().from(articleStageRuns).where(eq(articleStageRuns.runId, runId))).map((r: { stage: string }) => r.stage);

  test("a normal run ends with an in_review post, a rendered citation and no markers; no keyword lookup", async () => {
    const { run } = await t!.fixture("normal");
    const { deps, keywordCalls } = t!.makeDeps({ drafts: [t!.GOOD_ARTICLE], revisions: [] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("done");
    expect(end.reviseCount).toBe(0);
    const post = await postOf(end.postId);
    expect(post.editorialState).toBe("in_review");
    expect(post.content).not.toContain("{{c:");
    expect(post.content).toContain("https://source1.example/report");
    expect(post.content).toContain("## Sources");
    expect(post.title).toBe("Solar for small teams, explained");
    expect((post.publishingMetadata as { engine: unknown }).engine).toEqual({ runId: run.id, mode: "normal", escalated: false });
    expect(keywordCalls.n).toBe(0);
    expect(await stages(run.id)).not.toContain("revise");
  });

  test("a deep run revises a short draft, calls the keyword lookup once and ends in_review", async () => {
    const { run, job } = await t!.fixture("deep");
    const { deps, keywordCalls, llm } = t!.makeDeps({ drafts: [t!.SHORT_ARTICLE], revisions: [t!.GOOD_ARTICLE] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("done");
    expect(end.reviseCount).toBe(1);
    expect(keywordCalls.n).toBe(1);
    expect(llm.calls.filter((c) => c.role === "revise")).toHaveLength(1);
    const post = await postOf(end.postId);
    expect(post.editorialState).toBe("in_review");
    expect(post.content).not.toContain("{{c:");
    expect(post.content).toMatch(/\]\(https:\/\/source\d\.example\/report\)/);
    expect(post.jobId).toBe(job.id);
  });

  test("gates that keep failing deliver the draft and escalate the run", async () => {
    const { run } = await t!.fixture("normal");
    const { deps } = t!.makeDeps({ drafts: [t!.SHORT_ARTICLE], revisions: [t!.SHORT_ARTICLE] });
    const end = await t!.drive(run.id, deps);
    expect(end.state).toBe("escalated");
    expect(end.stateReason).toStartWith("Gates still failing");
    const post = await postOf(end.postId);
    expect(post.editorialState).toBe("in_review");
    expect((post.publishingMetadata as { engine: { escalated: boolean } }).engine.escalated).toBe(true);
  });
});
