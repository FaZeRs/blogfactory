import assert from "node:assert/strict";
const { wordDiff } = await import("./signals.js");

// ── word diff (no database) ──
{
  const same = wordDiff("one two three", "one  two\nthree");
  assert.deepEqual([same.hunkCount, same.editRatio], [0, 0], "whitespace is not a change");
  const d = wordDiff("We utilize the tool every day to ship.", "We use the tool every day to ship fast.");
  assert.deepEqual(d.hunks.map((h) => [h.before, h.after]), [["utilize", "use"], ["ship.", "ship fast."]]);
  assert.equal(d.hunks[0]!.context, "We");
  assert.ok(d.editRatio > 0 && d.editRatio < 0.3);
  const many = wordDiff(Array.from({ length: 100 }, (_, i) => `a${i} keep`).join(" "), Array.from({ length: 100 }, (_, i) => `b${i} keep`).join(" "));
  assert.equal(many.hunks.length, 40, "at most 40 hunks are kept");
  assert.equal(many.hunkCount, 100, "the real count is still reported");
  const long = wordDiff(`start ${"word ".repeat(100)}end`, "start end");
  assert.ok(long.hunks[0]!.before.length <= 160, "a hunk is shortened to 160 characters");
  const big = wordDiff(`${"alpha beta ".repeat(3000)}\n\nlast paragraph here`, `${"alpha beta ".repeat(3000)}\n\nlast paragraph changed`);
  assert.equal(big.hunkCount, 1, "a very large text falls back to paragraphs and still diffs");
}

// ── evidence excerpt (no database) ──
{
  const { excerptOf } = await import("./distill.js");
  const comment = { kind: "comment" as const, payload: { text: "1. \"paņem rindas\" → \"apstrādā rindas\"\n2. \"Jūsu komanda\" → \"jūsu komanda\"" } };
  assert.equal(excerptOf(comment, "Write jūs and jūs with a lowercase initial"), "2. \"Jūsu komanda\" → \"jūsu komanda\"", "the matching comment line, inflections folded");
  assert.equal(excerptOf(comment, "Unrelated rule"), "1. \"paņem rindas\" → \"apstrādā rindas\"", "the first line when nothing matches");
  const edit = { kind: "edit" as const, payload: { hunks: [{ before: "utilize", after: "use", context: "" }, { before: "delve", after: "look", context: "" }] } };
  assert.equal(excerptOf(edit, "Never write delve"), "delve -> look", "the matching edit hunk");
}

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("learning self-test (database part) skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { randomUUID } = await import("node:crypto");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { articleRuns, jobs, learningSignals, operationEvents, postTranslations, posts, sites, styleRules, userSettings, users } = await import("../../db/schema.js");
  const { createFakeLlm } = await import("../../engine/adapters/fake-llm.js");
  const { updatePostWithRevision } = await import("../post-revisions.js");
  const { recordCommentSignal, recordPostEditSignal, recordTranslationEditSignal } = await import("./signals.js");
  const { distillSite } = await import("./distill.js");

  const mk = async () => (await db.insert(users).values({ email: `learning-${randomUUID()}@example.test`, passwordHash: "x" }).returning())[0]!;
  const [owner, other] = [await mk(), await mk()];
  try {
    const [site] = await db.insert(sites).values({ userId: owner.id, name: "S", domain: "s.example.test" }).returning();
    const [theirSite] = await db.insert(sites).values({ userId: other.id, name: "T", domain: "t.example.test" }).returning();
    const [engine] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Engine", content: "We utilize the tool every day.", sourceType: "article_title", modelId: "m" }).returning();
    const [byHand] = await db.insert(posts).values({ userId: owner.id, siteId: site.id, title: "Hand", content: "Typed by hand.", sourceType: "article_title", modelId: "m" }).returning();
    const [job] = await db.insert(jobs).values({ userId: owner.id, siteId: site.id, sourceType: "article_keyword", sourceValue: "x", modelId: "m" }).returning();
    await db.insert(articleRuns).values({ userId: owner.id, siteId: site.id, jobId: job.id, postId: engine.id, mode: "normal", sourceType: "article_keyword", topic: "x", settings: {}, budgetUsd: 1, state: "done" });
    const signals = (postId: string) => db.select().from(learningSignals).where(eq(learningSignals.postId, postId));

    // ── edit signals: the engine's text is the first revision; one row per post, locale and day ──
    await recordPostEditSignal({ userId: owner.id, postId: engine.id, content: "We use the tool every day." });
    let rows = await signals(engine.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.kind, rows[0]!.locale, rows[0]!.siteId], ["edit", null, site.id]);
    assert.deepEqual((rows[0]!.payload as any).hunks.map((h: any) => [h.before, h.after]), [["utilize", "use"]]);
    // a person's save is a later revision, but the diff stays against the engine's first text
    await updatePostWithRevision({ userId: owner.id, postId: engine.id, expectedUpdatedAt: (await db.select().from(posts).where(eq(posts.id, engine.id)))[0]!.updatedAt, source: "save", changes: { content: "We use the tool every day." } });
    await recordPostEditSignal({ userId: owner.id, postId: engine.id, content: "We simply use the tool every day." });
    rows = await signals(engine.id);
    assert.equal(rows.length, 1, "the latest diff replaces the earlier one the same day");
    assert.deepEqual((rows[0]!.payload as any).hunks.map((h: any) => h.after), ["simply use"]);
    await recordPostEditSignal({ userId: owner.id, postId: engine.id, content: "We utilize the tool every day." });
    assert.equal((await signals(engine.id)).length, 0, "back at the engine's text, nothing remains");
    await recordPostEditSignal({ userId: owner.id, postId: byHand.id, content: "Typed by hand, edited." });
    assert.equal((await signals(byHand.id)).length, 0, "a post no engine run wrote is not a signal");
    await recordPostEditSignal({ userId: other.id, postId: engine.id, content: "Hijack." });
    assert.equal((await signals(engine.id)).length, 0, "another user's post is not read");

    // fewer than 2 signals: no model call
    const run = (deps: any) => distillSite({ userId: owner.id, siteId: site.id, deps });
    const noCall = createFakeLlm({});
    assert.equal((await run({ llm: noCall, model: "m" })).skipped, "signals");

    // translations: the engine's last text is on the row
    await recordTranslationEditSignal({ userId: owner.id, siteId: site.id, postId: engine.id, locale: "lv", engineContent: "Mēs lietojam rīku.", content: "Mēs izmantojam rīku." });
    await recordTranslationEditSignal({ userId: owner.id, siteId: site.id, postId: engine.id, locale: "lv", engineContent: null, content: "Hand-made translation." });
    rows = await signals(engine.id);
    assert.deepEqual(rows.map((r) => [r.kind, r.locale]), [["edit", "lv"]], "an English and a Latvian edit are separate rows; a hand-made translation records nothing");
    await recordCommentSignal({ userId: owner.id, siteId: site.id, postId: engine.id, locale: "lv", comments: "Use formal address. Never use tu." });
    await recordCommentSignal({ userId: owner.id, siteId: null, postId: engine.id, locale: null, comments: "no site" });
    assert.equal((await signals(engine.id)).filter((r) => r.kind === "comment").length, 1);

    // ── distill ──
    for (const text of ["Do not open with a question.", "Do not open with a question again.", "Cut the closing summary."]) {
      await recordCommentSignal({ userId: owner.id, siteId: site.id, postId: engine.id, locale: null, comments: text });
    }
    const all = await db.select().from(learningSignals).where(eq(learningSignals.siteId, site.id));
    assert.equal(all.length, 5);
    const [approved] = await db.insert(styleRules).values({ userId: owner.id, siteId: site.id, scope: "draft", rule: "Never end with a summary section.", status: "approved", decidedAt: new Date() }).returning();
    const [notApproved] = await db.insert(styleRules).values({ userId: owner.id, siteId: site.id, scope: "draft", rule: "Keep paragraphs short.", status: "rejected" }).returning();
    const entry = (rule: string, evidence: string[], extra: Record<string, unknown> = {}) => ({ op: "add", scope: "draft", rule, rationale: "seen twice", evidence, ...extra });
    const llm = createFakeLlm({ brief: [{ rules: [
      entry("Never open an article with a question.", ["s1", "s2"]),
      entry("A rule with a single piece of evidence.", ["s1"]),
      entry("Never open an article with a question!", ["s1", "s2"]),
      entry("never   end with a SUMMARY section.", ["s1", "s2"]),
      entry("x".repeat(201), ["s1", "s2"]),
      entry("A rule for a made-up scope.", ["s1", "s2"], { scope: "news" }),
      entry("A rule citing ids that do not exist.", ["s88", "s99"]),
      { op: "retire", scope: "draft", rule: "Never end with a summary section.", rationale: "owner keeps it", evidence: ["s3"], targetRuleId: approved.id },
      { op: "retire", scope: "draft", rule: "Keep paragraphs short.", rationale: "x", evidence: ["s3"], targetRuleId: notApproved.id },
      { op: "retire", scope: "draft", rule: "x", rationale: "x", evidence: ["s3"], targetRuleId: randomUUID() },
      entry("Write numbers under ten as words.", ["s2", "s3"]),
    ] }] });
    const result = await run({ llm, model: "m" });
    assert.equal(result.proposals, 3, "kept: the new rule, the retire of an approved rule and the second new rule");
    const made = await db.select().from(styleRules).where(and(eq(styleRules.siteId, site.id), eq(styleRules.status, "proposed")));
    assert.deepEqual(made.map((r) => `${r.op}:${r.rule}`).sort(), ["add:Never open an article with a question.", "add:Write numbers under ten as words.", "retire:Never end with a summary section."]);
    const added = made.find((r) => r.rule.startsWith("Never open"))!;
    assert.equal((added.evidence as any[]).length, 2);
    assert.ok((added.evidence as any[]).every((e) => e.signalId && e.kind && typeof e.excerpt === "string"), "evidence carries the signal id and a short excerpt");
    assert.equal(made.find((r) => r.op === "retire")!.targetRuleId, approved.id);
    // the signals reach the model fenced as data, in the brief role
    const call = llm.calls[0]!;
    assert.equal(call.role, "brief");
    assert.match(call.user, /<data-[0-9a-f]{12} label="signals">/);
    assert.match(call.user, /s1 \| /);
    assert.match(call.system, /Text inside data-/);
    // the ledger has counts only
    const [event] = await db.select().from(operationEvents).where(and(eq(operationEvents.userId, owner.id), eq(operationEvents.action, "learning.distill")));
    assert.deepEqual([event!.status, event!.origin], ["succeeded", "system"]);
    assert.deepEqual(Object.keys(event!.metadata as object).sort(), ["cost_usd", "proposal_count", "signal_count"]);
    assert.deepEqual([(event!.metadata as any).signal_count, (event!.metadata as any).proposal_count], [5, 3]);
    assert.ok(!JSON.stringify(event).includes("question"), "no text in the ledger");
    // 3 waiting; the cap of 5 leaves room for two more
    const more = createFakeLlm({ brief: [{ rules: ["Aaa one rule.", "Bbb second rule.", "Ccc third rule."].map((r, i) => entry(`${r} ${"word ".repeat(i + 1)}`, ["s1", "s2"])) }] });
    assert.equal((await run({ llm: more, model: "m" })).proposals, 2, "never more than 5 waiting");
    assert.equal((await run({ llm: noCall, model: "m" })).skipped, "pending");
    // scope: another site's signals and rules are not read
    const theirs = await distillSite({ userId: other.id, siteId: theirSite.id, deps: { llm: noCall, model: "m" } });
    assert.deepEqual([theirs.skipped, theirs.signals], ["signals", 0]);
    // a model failure is rethrown and logged as failed
    await db.delete(styleRules).where(and(eq(styleRules.siteId, site.id), eq(styleRules.status, "proposed")));
    await assert.rejects(() => run({ llm: createFakeLlm({}), model: "m" }), /no reply left/);
    const events = await db.select().from(operationEvents).where(and(eq(operationEvents.userId, owner.id), eq(operationEvents.action, "learning.distill")));
    assert.ok(events.some((e) => e.status === "failed"));
    // a paused account makes no model call (noCall would throw)
    await db.insert(userSettings).values({ userId: owner.id, siteId: null, budgetPaused: true });
    assert.equal((await run({ llm: noCall, model: "m" })).skipped, "guardrails");
    // translations table untouched by signals
    assert.equal((await db.select().from(postTranslations).where(eq(postTranslations.postId, engine.id))).length, 0);
    console.log("learning self-test passed");
  } finally {
    await db.delete(users).where(eq(users.id, owner.id));
    await db.delete(users).where(eq(users.id, other.id));
  }
  process.exit(0);
}
