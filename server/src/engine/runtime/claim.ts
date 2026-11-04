import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleRuns } from "../../db/schema.js";
import type { ArticleRunRow } from "./stage.js";

/** One statement: SKIP LOCKED makes concurrent workers take disjoint runs. Claims are global; every later write is user-scoped. */
export async function claimArticleRuns(workerId: string, limit: number, now: Date, leaseMs = 20 * 60_000): Promise<ArticleRunRow[]> {
  if (limit < 1) return [];
  const nowIso = now.toISOString();
  return db
    .update(articleRuns)
    .set({ leaseOwner: workerId, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(sql`${articleRuns.id} IN (
      SELECT id FROM article_runs
      WHERE state = 'active' AND next_attempt_at <= ${nowIso}::timestamptz
        AND (lease_expires_at IS NULL OR lease_expires_at < ${nowIso}::timestamptz)
      ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT ${limit})`)
    .returning();
}
