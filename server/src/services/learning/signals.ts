import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleRuns, learningSignals, postRevisions, posts } from "../../db/schema.js";
import { postRevisionSnapshot } from "../post-revisions.js";

export const SIGNAL_LIMITS = { hunks: 40, excerpt: 160, comment: 2000, context: 6 } as const;

export type Hunk = { before: string; after: string; context: string };
export type EditPayload = { hunks: Hunk[]; hunkCount: number; editRatio: number };

const clip = (text: string, max: number = SIGNAL_LIMITS.excerpt) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Above this many cells the word-level table is too big for a request; paragraphs are compared instead.
const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence match of two token lists, as the matched index pairs in order. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const w = b.length + 1;
  const t = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/** A word-level diff of the engine's text against the person's: the changed hunks (at most 40, each shortened) and the share of words changed. */
export function wordDiff(before: string, after: string): EditPayload {
  const split = (s: string, by: RegExp) => s.split(by).filter(Boolean);
  const trimEnds = (x: string[], y: string[]) => {
    let h = 0;
    while (h < x.length && h < y.length && x[h] === y[h]) h += 1;
    let t = 0;
    while (t < x.length - h && t < y.length - h && x[x.length - 1 - t] === y[y.length - 1 - t]) t += 1;
    return [h, t] as const;
  };
  let sep = /\s+/;
  let a = split(before.trim(), sep);
  let b = split(after.trim(), sep);
  let [head, tail] = trimEnds(a, b);
  // shortcut: when the changed middle is this large it is diffed by paragraph, so its hunks are coarser; upgrade to a Myers diff if that matters.
  if ((a.length - head - tail) * (b.length - head - tail) > MAX_CELLS) {
    sep = /\n\s*\n/; a = split(before.trim(), sep); b = split(after.trim(), sep);
    [head, tail] = trimEnds(a, b);
  }
  const join = sep.source === "\\s+" ? " " : "\n\n";
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const pairs = lcsPairs(ma, mb).map(([x, y]): [number, number] => [x + head, y + head]);
  const hunks: Hunk[] = [];
  let changed = 0;
  let [i, j] = [head, head];
  // The unchanged tail is not scanned: it runs to the end of both lists.
  const flush = (ni: number, nj: number) => {
    if (ni > i || nj > j) {
      changed += (ni - i) + (nj - j);
      hunks.push({ before: clip(a.slice(i, ni).join(join)), after: clip(b.slice(j, nj).join(join)), context: a.slice(Math.max(0, i - SIGNAL_LIMITS.context), i).join(join).slice(-80) });
    }
  };
  for (const [pi, pj] of pairs) { flush(pi, pj); i = pi + 1; j = pj + 1; }
  flush(a.length - tail, b.length - tail);
  return { hunks: hunks.slice(0, SIGNAL_LIMITS.hunks), hunkCount: hunks.length, editRatio: Math.round((changed / Math.max(1, a.length + b.length)) * 1000) / 1000 };
}

async function putEdit(input: { userId: string; siteId: string; postId: string; locale: string | null; payload: EditPayload | null }) {
  const { userId, siteId, postId, locale, payload } = input;
  if (!payload || payload.hunkCount === 0) {
    // The person is back at the engine's text: today's earlier diff no longer applies.
    await db.delete(learningSignals).where(and(
      eq(learningSignals.userId, userId), eq(learningSignals.siteId, siteId), eq(learningSignals.postId, postId), eq(learningSignals.kind, "edit"),
      sql`coalesce(${learningSignals.locale}, '') = ${locale ?? ""}`, sql`${learningSignals.day} = (now() AT TIME ZONE 'utc')::date`,
    ));
    return;
  }
  // One row per post, locale and day: the latest diff replaces the earlier one.
  await db.execute(sql`
    INSERT INTO learning_signals (user_id, site_id, post_id, locale, kind, payload)
    VALUES (${userId}::uuid, ${siteId}::uuid, ${postId}::uuid, ${locale}, 'edit', ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (post_id, COALESCE(locale, ''), day) WHERE kind = 'edit'
    DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`);
}

/**
 * The engine's text of a post is its first revision (`initial`, written when the engine delivers) or the latest `refresh` revision:
 * a later `save` is a person's. Null when no engine run delivered this post.
 */
export async function engineText(userId: string, siteId: string, postId: string): Promise<string | null> {
  const [run] = await db.select({ id: articleRuns.id }).from(articleRuns)
    .where(and(eq(articleRuns.postId, postId), eq(articleRuns.userId, userId), eq(articleRuns.siteId, siteId))).limit(1);
  if (!run) return null;
  const [rev] = await db.select({ snapshot: postRevisions.snapshot }).from(postRevisions)
    .where(and(eq(postRevisions.postId, postId), eq(postRevisions.userId, userId), inArray(postRevisions.source, ["initial", "refresh"])))
    .orderBy(desc(postRevisions.revisionNumber)).limit(1);
  return rev ? postRevisionSnapshot(rev.snapshot).content : null;
}

/** Best effort: a person saved an engine-made post. Never throws, so it cannot fail the save. */
export async function recordPostEditSignal(input: { userId: string; postId: string; content: string }) {
  try {
    const [post] = await db.select({ siteId: posts.siteId }).from(posts).where(and(eq(posts.id, input.postId), eq(posts.userId, input.userId))).limit(1);
    if (!post?.siteId) return;
    const engine = await engineText(input.userId, post.siteId, input.postId);
    if (engine === null) return;
    await putEdit({ userId: input.userId, siteId: post.siteId, postId: input.postId, locale: null, payload: wordDiff(engine, input.content) });
  } catch {
    console.error("[learning] Could not record an edit signal");
  }
}

/** Best effort: a person saved a translation. `engineContent` is what the engine last wrote (null for a hand-made one). */
export async function recordTranslationEditSignal(input: { userId: string; siteId: string; postId: string; locale: string; engineContent: string | null; content: string }) {
  try {
    if (input.engineContent === null) return;
    await putEdit({ userId: input.userId, siteId: input.siteId, postId: input.postId, locale: input.locale, payload: wordDiff(input.engineContent, input.content) });
  } catch {
    console.error("[learning] Could not record an edit signal");
  }
}

/** Best effort: the owner's comments to Revise with comments (`locale` null) or Revise translation. */
export async function recordCommentSignal(input: { userId: string; siteId: string | null; postId: string; locale: string | null; comments: string }) {
  try {
    if (!input.siteId) return;
    await db.insert(learningSignals).values({
      userId: input.userId, siteId: input.siteId, postId: input.postId, locale: input.locale, kind: "comment",
      payload: { text: clip(input.comments.trim(), SIGNAL_LIMITS.comment) },
    });
  } catch {
    console.error("[learning] Could not record a comment signal");
  }
}
