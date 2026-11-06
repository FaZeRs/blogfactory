import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { postRevisions } from "../../db/schema.js";
import { postRevisionSnapshot } from "../post-revisions.js";

type Revision = { id: string; snapshot: unknown } | null;

const sourceText = (snapshot: unknown) => {
  const s = postRevisionSnapshot(snapshot);
  return JSON.stringify([s.title, s.summary, s.content]);
};

/**
 * Which translation source revisions are out of date against the post's current revision. A newer revision only makes a
 * translation stale when the English text (title, description, content) changed: saving SEO or publishing metadata
 * creates a revision too, and must not hold a translation back.
 */
export async function staleSourceRevisions(userId: string, sourceIds: (string | null)[], current: Revision): Promise<Set<string | null>> {
  const stale = new Set<string | null>();
  if (!current) {
    for (const id of sourceIds) stale.add(id);
    return stale;
  }
  const others = [...new Set(sourceIds.filter((id): id is string => !!id && id !== current.id))];
  if (sourceIds.includes(null)) stale.add(null);
  if (!others.length) return stale;
  const rows = await db.select({ id: postRevisions.id, snapshot: postRevisions.snapshot }).from(postRevisions)
    .where(and(eq(postRevisions.userId, userId), inArray(postRevisions.id, others)));
  const now = sourceText(current.snapshot);
  const found = new Map(rows.map((r) => [r.id, sourceText(r.snapshot)]));
  for (const id of others) if (found.get(id) !== now) stale.add(id);
  return stale;
}

/** A translation is stale when its source revision is; a placeholder that is still being made has no text to be out of date. */
export const isTranslationStale = (row: { status: string; sourceRevisionId: string | null }, stale: Set<string | null>) =>
  row.status !== "running" && stale.has(row.sourceRevisionId);
