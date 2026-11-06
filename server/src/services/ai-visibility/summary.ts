import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiAnswerChecks, generationLogs } from "../../db/schema.js";

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** ISO 8601 week, "YYYY-Www", from the UTC date. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // the week's Thursday decides its year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const n = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

/** The ISO week before `week` ("2026-W01" gives "2025-W52"). */
export function previousIsoWeek(week: string): string {
  const [year, n] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() || 7) - 1) + 7 * (n - 1));
  return isoWeek(new Date(monday - 7 * 86_400_000));
}

/**
 * This UTC month's spend on a site's checks, failed calls included. Read from the spend log, where each call keeps its own
 * timestamp; a check row's cost sums its retries under the last try's date.
 */
export async function monthCost(userId: string, siteId: string, now = new Date()): Promise<number> {
  const [row] = await db.select({ total: sql<number>`COALESCE(SUM(${generationLogs.cost}), 0)::float8` }).from(generationLogs)
    .where(and(eq(generationLogs.userId, userId), sql`${generationLogs.responseData}->'aiVisibility'->>'siteId' = ${siteId}`, gte(generationLogs.createdAt, monthStart(now))));
  return Number(row?.total ?? 0);
}

type Row = Pick<typeof aiAnswerChecks.$inferSelect, "week" | "questionHash" | "question" | "engine" | "engineLabel" | "status" | "cited" | "mentioned" | "otherHosts" | "competitorHosts">;

const ratio = (n: number, d: number) => (d ? n / d : 0);
const ranked = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h);

/** Questions that no engine cited the site for while some engine cited another host. */
function gapsOf(rows: Row[]) {
  const byQuestion = new Map<string, { question: string; cited: boolean; comp: Map<string, number>; other: Map<string, number>; anyHost: boolean }>();
  for (const r of rows) {
    if (r.status !== "ok") continue;
    const q = byQuestion.get(r.questionHash) ?? { question: r.question, cited: false, comp: new Map(), other: new Map(), anyHost: false };
    q.cited ||= r.cited;
    for (const h of r.otherHosts) {
      q.anyHost = true;
      const bucket = r.competitorHosts.includes(h) ? q.comp : q.other;
      bucket.set(h, (bucket.get(h) ?? 0) + 1);
    }
    byQuestion.set(r.questionHash, q);
  }
  return new Map([...byQuestion].filter(([, q]) => !q.cited && q.anyHost));
}

export type VisibilitySummary = Awaited<ReturnType<typeof visibilitySummary>>;

export async function visibilitySummary(userId: string, siteId: string, now = new Date()) {
  const own = and(eq(aiAnswerChecks.userId, userId), eq(aiAnswerChecks.siteId, siteId));
  const weekRows = await db.selectDistinct({ week: aiAnswerChecks.week }).from(aiAnswerChecks).where(own).orderBy(desc(aiAnswerChecks.week)).limit(12);
  const weeks = weekRows.map((w) => w.week); // newest first
  const rows: Row[] = weeks.length ? await db.select({
    week: aiAnswerChecks.week, questionHash: aiAnswerChecks.questionHash, question: aiAnswerChecks.question, engine: aiAnswerChecks.engine,
    engineLabel: aiAnswerChecks.engineLabel, status: aiAnswerChecks.status, cited: aiAnswerChecks.cited, mentioned: aiAnswerChecks.mentioned,
    otherHosts: aiAnswerChecks.otherHosts, competitorHosts: aiAnswerChecks.competitorHosts,
  }).from(aiAnswerChecks).where(and(own, inArray(aiAnswerChecks.week, weeks))) : [];

  const byWeek = new Map<string, Row[]>();
  for (const r of rows) byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r]);
  const shareOf = (list: Row[]) => {
    const answered = new Map<string, boolean>();
    for (const r of list) if (r.status === "ok") answered.set(r.questionHash, (answered.get(r.questionHash) ?? false) || r.cited);
    const cited = [...answered.values()].filter(Boolean).length;
    return { answered: answered.size, cited, share: ratio(cited, answered.size) };
  };

  const week = weeks[0] ?? null;
  const latestRows = week ? byWeek.get(week) ?? [] : [];
  const ok = latestRows.filter((r) => r.status === "ok");
  const { answered, cited, share } = shareOf(latestRows);
  const mentionedQuestions = new Set(ok.filter((r) => r.mentioned).map((r) => r.questionHash)).size;

  const engines = new Map<string, { engine: string; label: string; asked: number; cited: number }>();
  for (const r of ok) {
    const e = engines.get(r.engine) ?? { engine: r.engine, label: r.engineLabel, asked: 0, cited: 0 };
    e.asked += 1;
    if (r.cited) e.cited += 1;
    engines.set(r.engine, e);
  }

  const hostCounts = new Map<string, number>();
  const flagged = new Set<string>();
  for (const r of ok) {
    for (const h of r.otherHosts) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
    for (const h of r.competitorHosts) flagged.add(h);
  }

  const gaps = gapsOf(latestRows);
  // Only the calendar week before counts; a skipped week breaks the run.
  const previousGaps = week && weeks[1] === previousIsoWeek(week) ? gapsOf(byWeek.get(weeks[1]) ?? []) : new Map();
  const gapList = [...gaps].map(([hash, g]) => ({
    question: g.question,
    competitorHosts: ranked(g.comp).slice(0, 10),
    otherHosts: ranked(g.other).slice(0, 10),
    twoWeeks: previousGaps.has(hash),
  })).sort((a, b) => Number(b.twoWeeks) - Number(a.twoWeeks) || b.competitorHosts.length - a.competitorHosts.length || a.question.localeCompare(b.question));

  const checks = week ? (await db.select().from(aiAnswerChecks).where(and(own, eq(aiAnswerChecks.week, week))).orderBy(aiAnswerChecks.question, aiAnswerChecks.engine))
    .map(({ userId: _user, ...row }) => row) : [];

  return {
    week,
    latest: {
      questions: new Set(latestRows.map((r) => r.questionHash)).size,
      answered,
      citedQuestions: cited,
      share,
      mentionedShare: ratio(mentionedQuestions, answered),
      engines: [...engines.values()].map((e) => ({ ...e, share: ratio(e.cited, e.asked) })),
    },
    trend: [...weeks].reverse().map((w) => {
      const s = shareOf(byWeek.get(w) ?? []);
      return { week: w, share: s.share, answered: s.answered };
    }),
    topCompetitors: ranked(hostCounts).slice(0, 10).map((host) => ({ host, count: hostCounts.get(host)!, flagged: flagged.has(host) })),
    gaps: gapList,
    checks,
    costThisMonth: await monthCost(userId, siteId, now),
  };
}
