import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ideas, siteIntegrations } from "../../db/schema.js";
import { startArticleRun } from "../../engine/article-runs.js";
import { truncate } from "../../engine/util.js";
import { finishOperationEvent, startOperationEvent } from "../operation-events.js";
import { getEffectiveSettings } from "../user-settings.js";
import { getIdeaSettings, type IdeaSettings } from "./settings.js";

type Cadence = IdeaSettings["cadence"];
type Idea = typeof ideas.$inferSelect;

const DAY_MS = 86_400_000;
/** A slot is held by an idea in one of these states; rejected and archived ideas release it. */
export const SLOT_STATUSES = ["approved", "scheduled", "in_progress", "drafted"] as const;
export const RETRY_BACKOFF_MS = 30 * 60_000;

// ── time zones, through Intl only ──

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsOf(ms: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

/** The zone's UTC offset at an instant, in ms. */
function offsetMs(ms: number, tz: string) {
  const p = partsOf(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant a wall-clock time has in a zone. The second pass settles times next to a DST change. */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetMs(wall, tz);
  return new Date(wall - offsetMs(first, tz));
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(at: Date, tz: string): string {
  const p = partsOf(at.getTime(), tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Cadence slots at or after `from`, in order. The caller stops iterating. */
export function* cadenceSlots(cadence: Cadence, from: Date): Generator<Date> {
  const [hh, mm] = cadence.time.split(":").map(Number) as [number, number];
  const start = partsOf(from.getTime(), cadence.timezone);
  for (let i = 0; i < 800; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    if (!cadence.weekdays.includes(day.getUTCDay())) continue;
    const slot = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, cadence.timezone);
    if (slot.getTime() >= from.getTime()) yield slot;
  }
}

export function slotsBetween(cadence: Cadence, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (const slot of cadenceSlots(cadence, from)) {
    if (slot.getTime() >= to.getTime()) break;
    out.push(slot);
  }
  return out;
}

/** A date the owner picked: a full timestamp as is, or "YYYY-MM-DD" at the cadence time in the site's zone. */
export function parseScheduledFor(value: unknown, cadence: Cadence): Date | null {
  if (typeof value !== "string") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const at = day
    ? zonedTimeToUtc(Number(day[1]), Number(day[2]), Number(day[3]), Number(cadence.time.slice(0, 2)), Number(cadence.time.slice(3)), cadence.timezone)
    : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

// ── booking ──

async function bookedTimes(userId: string, siteId: string, exceptId?: string) {
  const rows = await db.select({ id: ideas.id, at: ideas.scheduledFor }).from(ideas).where(and(
    eq(ideas.userId, userId), eq(ideas.siteId, siteId), isNotNull(ideas.scheduledFor), inArray(ideas.status, [...SLOT_STATUSES]),
  ));
  return new Set(rows.flatMap((r) => (r.at && r.id !== exceptId ? [r.at.getTime()] : [])));
}

/** The first cadence slot at least `leadDays` from now that no idea holds. */
export async function nextFreeSlot(userId: string, siteId: string, settings: IdeaSettings, now: Date, exceptId?: string): Promise<Date> {
  const taken = await bookedTimes(userId, siteId, exceptId);
  const after = new Date(now.getTime() + settings.leadDays * DAY_MS);
  for (const slot of cadenceSlots(settings.cadence, after)) if (!taken.has(slot.getTime())) return slot;
  throw new Error("No free slot");
}

export class SlotTakenError extends Error {
  constructor() { super("That slot already has an idea"); this.name = "SlotTakenError"; }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

/**
 * Moves an idea in one of `from` to `scheduled` on a slot: the given date, or the next free cadence slot.
 * The unique index decides races: a taken date throws SlotTakenError, an automatic slot tries the next one.
 * Resolves to null when the idea is not in a `from` state.
 */
export async function bookIdea(input: {
  userId: string; siteId: string; ideaId: string; settings: IdeaSettings; from: readonly string[];
  scheduledFor?: Date; edits?: Partial<typeof ideas.$inferInsert>; now?: Date;
}): Promise<Idea | null> {
  const now = input.now ?? new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    const slot = input.scheduledFor ?? await nextFreeSlot(input.userId, input.siteId, input.settings, now, input.ideaId);
    try {
      const [row] = await db.update(ideas)
        .set({ ...input.edits, status: "scheduled", scheduledFor: slot, error: null, updatedAt: now })
        .where(and(eq(ideas.id, input.ideaId), eq(ideas.userId, input.userId), eq(ideas.siteId, input.siteId), inArray(ideas.status, [...input.from])))
        .returning();
      return row ?? null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (input.scheduledFor) throw new SlotTakenError();
    }
  }
  throw new SlotTakenError();
}

// ── ledger ──

/** One sanitized event for an idea mutation: ids and status only. */
export async function logIdeaEvent(input: { userId: string; siteId: string; action: string; ideaId?: string; origin?: "web" | "system"; status?: string }) {
  try {
    const id = await startOperationEvent({
      userId: input.userId, siteId: input.siteId, origin: input.origin ?? "web", clientName: input.origin === "system" ? null : "BlogFactory web",
      action: input.action, objectType: "idea", objectId: input.ideaId, metadata: input.status ? { status: input.status } : {},
    });
    await finishOperationEvent({ id, status: "succeeded", durationMs: 0, siteId: input.siteId, metadata: input.status ? { status: input.status } : {} });
  } catch {
    console.error("[ideas] Could not write the operation event");
  }
}

// ── starting runs ──

export type StartRun = typeof startArticleRun;

function instructionsFor(idea: Idea) {
  const brief = (idea.brief ?? {}) as { whyNow?: string; outline?: string[]; informationGain?: string[] };
  return truncate([
    idea.primaryKeyword ? `Primary keyword: ${idea.primaryKeyword}` : "",
    brief.whyNow ? `Why now: ${brief.whyNow}` : "",
    brief.outline?.length ? `Suggested outline: ${brief.outline.join("; ")}` : "",
    brief.informationGain?.length ? `Add information a typical top result lacks: ${brief.informationGain.join("; ")}` : "",
  ].filter(Boolean).join("\n"), 1500);
}

/**
 * Starts the article run for a `new` or `scheduled` idea and marks it `in_progress`. The claim comes first, so a second
 * caller finds nothing to start. When the run cannot start the idea goes back (to `scheduled` if it has a slot) with the
 * error, and the error is thrown. Resolves to null when the idea was not startable.
 */
export async function startIdea(userId: string, siteId: string, ideaId: string, run: StartRun = startArticleRun, now = new Date()) {
  const [claimed] = await db.update(ideas).set({ status: "in_progress", error: null, updatedAt: now })
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId), eq(ideas.siteId, siteId), inArray(ideas.status, ["new", "scheduled"])))
    .returning();
  if (!claimed) return null;
  try {
    const [settings, connected] = await Promise.all([
      getEffectiveSettings(userId, siteId),
      db.select({ id: siteIntegrations.id }).from(siteIntegrations)
        .where(and(eq(siteIntegrations.userId, userId), eq(siteIntegrations.siteId, siteId), eq(siteIntegrations.status, "connected"))),
    ]);
    const started = await run({
      userId, siteId, mode: claimed.mode === "deep" ? "deep" : "normal", sourceType: "article_title", topic: claimed.title,
      preferredIntegrationId: connected.length === 1 ? connected[0]!.id : null,
      origin: "web",
      guidance: { angle: claimed.angle, instructions: instructionsFor(claimed) },
      cover: Boolean(settings.imageModel),
    });
    const [row] = await db.update(ideas).set({ jobId: started.jobId, updatedAt: now }).where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId))).returning();
    return { idea: row!, run: started };
  } catch (error) {
    await db.update(ideas).set({
      status: claimed.scheduledFor ? "scheduled" : "new",
      error: truncate(error instanceof Error ? error.message : "The run could not start", 300),
      updatedAt: now,
    }).where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)));
    throw error;
  }
}

const MAX_LEAD_DAYS = 30;
const DUE_BATCH = 10;

/** Starts every scheduled idea whose slot minus the site's lead time has passed. A failed start waits 30 minutes before the next try. */
export async function startDueIdeas(now = new Date(), run: StartRun = startArticleRun): Promise<{ started: number; failed: number }> {
  const candidates = await db.select().from(ideas)
    .where(and(eq(ideas.status, "scheduled"), isNotNull(ideas.scheduledFor), lte(ideas.scheduledFor, new Date(now.getTime() + MAX_LEAD_DAYS * DAY_MS))))
    .orderBy(asc(ideas.scheduledFor)).limit(100);
  const lead = new Map<string, number>();
  let started = 0, failed = 0;
  for (const idea of candidates) {
    if (started + failed >= DUE_BATCH) break;
    if (idea.error && now.getTime() - idea.updatedAt.getTime() < RETRY_BACKOFF_MS) continue;
    const key = `${idea.userId}:${idea.siteId}`;
    if (!lead.has(key)) lead.set(key, (await getIdeaSettings(idea.userId, idea.siteId)).leadDays);
    if (idea.scheduledFor!.getTime() - lead.get(key)! * DAY_MS > now.getTime()) continue;
    try {
      if (await startIdea(idea.userId, idea.siteId, idea.id, run, now)) {
        started += 1;
        await logIdeaEvent({ userId: idea.userId, siteId: idea.siteId, action: "ideas.start", ideaId: idea.id, origin: "system", status: "in_progress" });
      }
    } catch {
      failed += 1;
    }
  }
  return { started, failed };
}

// ── autopilot ──

const weekStart = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
};

/**
 * Approves and books the best new ideas at or above minScore, up to approvePerWeek per ISO week.
 * shortcut: "approved this week" is read from updated_at (there is no approved_at), so a draft delivered this week counts; it only under-approves.
 */
export async function runAutopilot(userId: string, siteId: string, settings: IdeaSettings, now = new Date()): Promise<number> {
  if (!settings.autopilot.enabled) return 0;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ideas).where(and(
    eq(ideas.userId, userId), eq(ideas.siteId, siteId), inArray(ideas.status, ["scheduled", "in_progress", "drafted"]), gte(ideas.updatedAt, weekStart(now)),
  ));
  const room = settings.autopilot.approvePerWeek - (n ?? 0);
  if (room < 1) return 0;
  const top = await db.select({ id: ideas.id }).from(ideas).where(and(
    eq(ideas.userId, userId), eq(ideas.siteId, siteId), eq(ideas.status, "new"), gte(ideas.score, settings.autopilot.minScore),
  )).orderBy(sql`${ideas.score} DESC`).limit(room);
  let approved = 0;
  for (const { id } of top) {
    const row = await bookIdea({ userId, siteId, ideaId: id, settings, from: ["new"], now });
    if (row) {
      approved += 1;
      await logIdeaEvent({ userId, siteId, action: "ideas.approve", ideaId: id, origin: "system", status: "scheduled" });
    }
  }
  return approved;
}
