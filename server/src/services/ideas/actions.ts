import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ideaDiscoveries, ideas } from "../../db/schema.js";
import { SlotTakenError, bookIdea, parseScheduledFor } from "./schedule.js";
import { getIdeaSettings } from "./settings.js";

/** Shared by the web routes and the MCP tools: ownership, validation and state rules live here once. */
export const IDEA_STATUSES = ["new", "approved", "scheduled", "in_progress", "drafted", "rejected", "archived"] as const;
export const IDEA_SORTS = ["score", "newest", "scheduled"] as const;
const MODES = ["normal", "deep"] as const;

export type IdeaRow = typeof ideas.$inferSelect;

export class IdeaActionError extends Error {
  constructor(readonly kind: "not_found" | "validation" | "conflict", message: string, readonly field?: string) { super(message); }
}
const invalid = (field: string, message: string) => new IdeaActionError("validation", message, field);
/** Optimistic lock: the caller's copy of updated_at, compared to the millisecond inside the UPDATE so two tabs cannot overwrite each other. */
export function readExpectedUpdatedAt(body: Record<string, unknown>, required: boolean): Date | undefined {
  const raw = body.expectedUpdatedAt ?? body.expected_updated_at;
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw invalid("expectedUpdatedAt", "Required: the idea's updatedAt you edited");
    return undefined;
  }
  const at = typeof raw === "string" ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) throw invalid("expectedUpdatedAt", "Expected an ISO timestamp");
  return at;
}
export const sameVersion = (expected?: Date) => (expected ? [sql`date_trunc('milliseconds', ${ideas.updatedAt}) = ${expected.toISOString()}::timestamptz`] : []);
export const staleVersion = () => new IdeaActionError("conflict", "This idea changed since you opened it. Reload and try again.");

const conflict = (idea: IdeaRow, action: string) => new IdeaActionError("conflict", `A ${idea.status.replace("_", " ")} idea cannot be ${action}`);

export const serializeIdea = (r: IdeaRow) => ({
  id: r.id, siteId: r.siteId, status: r.status, title: r.title, angle: r.angle, primaryKeyword: r.primaryKeyword,
  alternateKeywords: r.alternateKeywords, searchIntent: r.searchIntent, audienceQuestion: r.audienceQuestion,
  brief: r.brief, score: r.score, scoreBreakdown: r.scoreBreakdown, origin: r.origin, discoveryId: r.discoveryId, mode: r.mode,
  scheduledFor: r.scheduledFor, jobId: r.jobId, postId: r.postId, rejectedReason: r.rejectedReason, error: r.error, failedRuns: r.failedRuns,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export const serializeDiscovery = (r: typeof ideaDiscoveries.$inferSelect) => ({
  id: r.id, siteId: r.siteId, status: r.status, signalCount: r.signalCount, ideaCount: r.ideaCount, costUsd: r.costUsd,
  error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, createdAt: r.createdAt,
});

/** Trimmed text within a length, or undefined when absent; null clears an optional field. */
export function optionalText(body: Record<string, unknown>, field: string, max: number, min = 0): string | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw invalid(field, "Expected text");
  const t = v.trim();
  if (t.length > max || t.length < min) throw invalid(field, `Expected ${min}-${max} characters`);
  return t || null;
}

export async function listIdeas(input: { userId: string; siteId: string; statuses?: readonly string[]; sort?: string; limit?: number }) {
  const wanted = input.statuses ?? [];
  if (wanted.some((s) => !(IDEA_STATUSES as readonly string[]).includes(s))) throw invalid("status", `Expected any of: ${IDEA_STATUSES.join(", ")}`);
  const sort = input.sort ?? "score";
  if (!(IDEA_SORTS as readonly string[]).includes(sort)) throw invalid("sort", `Expected one of: ${IDEA_SORTS.join(", ")}`);
  const order = sort === "newest" ? [desc(ideas.createdAt)] : sort === "scheduled" ? [sql`${ideas.scheduledFor} ASC NULLS LAST`, desc(ideas.score)] : [sql`${ideas.score} DESC NULLS LAST`, desc(ideas.createdAt)];
  return db.select().from(ideas).where(and(
    eq(ideas.userId, input.userId), eq(ideas.siteId, input.siteId),
    wanted.length ? inArray(ideas.status, [...wanted]) : ne(ideas.status, "archived"),
  )).orderBy(...order).limit(input.limit ?? 300);
}

/** The idea when it belongs to the user (and to the site, when given); 404 otherwise. */
export async function ownedIdeaRow(userId: string, id: string, siteId?: string) {
  const [row] = await db.select().from(ideas).where(and(eq(ideas.id, id), eq(ideas.userId, userId), ...(siteId ? [eq(ideas.siteId, siteId)] : []))).limit(1);
  if (!row) throw new IdeaActionError("not_found", "Idea not found");
  return row;
}

/** The editable fields shared by PATCH and approve. */
export function readIdeaEdits(body: Record<string, unknown>) {
  const edits: Partial<typeof ideas.$inferInsert> = {};
  const title = optionalText(body, "title", 160, 5);
  if (title === null) throw invalid("title", "Cannot be empty");
  if (title !== undefined) edits.title = title;
  const angle = optionalText(body, "angle", 500);
  if (angle !== undefined) edits.angle = angle;
  const keyword = optionalText(body, "primaryKeyword", 80);
  if (keyword !== undefined) edits.primaryKeyword = keyword;
  if (body.alternateKeywords !== undefined) {
    const k = body.alternateKeywords;
    if (!Array.isArray(k) || k.length > 6 || k.some((x) => typeof x !== "string" || !x.trim() || x.length > 80)) throw invalid("alternateKeywords", "Expected up to 6 short phrases");
    edits.alternateKeywords = (k as string[]).map((x) => x.trim());
  }
  if (body.mode !== undefined) {
    if (!(MODES as readonly unknown[]).includes(body.mode)) throw invalid("mode", `Expected one of: ${MODES.join(", ")}`);
    edits.mode = body.mode as "normal" | "deep";
  }
  let outline: string[] | undefined;
  if (body.outline !== undefined) {
    const o = body.outline;
    if (!Array.isArray(o) || o.length < 3 || o.length > 6 || o.some((x) => typeof x !== "string" || !x.trim() || x.length > 120)) throw invalid("outline", "Expected 3-6 headings");
    outline = (o as string[]).map((x) => x.trim());
  }
  return { edits, outline };
}

export const withOutline = (idea: IdeaRow, outline?: string[]) => (outline ? { brief: { ...(idea.brief as object), outline } } : {});

/** Approve (new -> scheduled) or reschedule (scheduled -> scheduled); never starts a run. */
export async function bookOwnedIdea(input: { userId: string; ideaId: string; siteId?: string; action: "approve" | "reschedule"; body: Record<string, unknown> }) {
  const { userId, action, body } = input;
  const idea = await ownedIdeaRow(userId, input.ideaId, input.siteId);
  const from = action === "approve" ? ["new"] : ["scheduled"];
  const verb = action === "approve" ? "approved" : "rescheduled";
  if (!from.includes(idea.status)) throw conflict(idea, verb);
  const { edits, outline } = action === "approve" ? readIdeaEdits(body) : { edits: {}, outline: undefined };
  // Edits without the version they were made against could overwrite someone else's save.
  const expectedUpdatedAt = readExpectedUpdatedAt(body, Object.keys(edits).length > 0 || outline !== undefined);
  if (expectedUpdatedAt && idea.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw staleVersion();
  const settings = await getIdeaSettings(userId, idea.siteId);
  let at: Date | undefined;
  if (body.scheduledFor === undefined || body.scheduledFor === null) {
    if (action === "reschedule") throw invalid("scheduledFor", "Required");
  } else {
    const parsed = parseScheduledFor(body.scheduledFor, settings.cadence);
    if (!parsed) throw invalid("scheduledFor", "Expected an ISO date (YYYY-MM-DD) or timestamp");
    if (parsed.getTime() <= Date.now()) throw invalid("scheduledFor", "Must be in the future");
    at = parsed;
  }
  let row: IdeaRow | null;
  try {
    row = await bookIdea({ userId, siteId: idea.siteId, ideaId: idea.id, settings, from, scheduledFor: at, expectedUpdatedAt, edits: { ...edits, ...withOutline(idea, outline) } });
  } catch (error) {
    if (error instanceof SlotTakenError) throw new IdeaActionError("conflict", error.message);
    throw error;
  }
  if (!row) throw expectedUpdatedAt ? staleVersion() : conflict(idea, verb);
  return row;
}

export async function rejectOwnedIdea(input: { userId: string; ideaId: string; siteId?: string; reason?: string | null }) {
  const idea = await ownedIdeaRow(input.userId, input.ideaId, input.siteId);
  const [row] = await db.update(ideas).set({ status: "rejected", rejectedReason: input.reason ?? null, scheduledFor: null, updatedAt: new Date() })
    .where(and(eq(ideas.id, idea.id), eq(ideas.userId, input.userId), inArray(ideas.status, ["new", "scheduled"]))).returning();
  if (!row) throw conflict(idea, "rejected");
  return row;
}
