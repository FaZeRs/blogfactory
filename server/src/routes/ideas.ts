import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ideaDiscoveries, ideas, posts } from "../db/schema.js";
import { EngineUnavailableError } from "../engine/article-runs.js";
import { StageInputError } from "../engine/types.js";
import { ApiError, readJsonObject, requiredString } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { queueDiscovery, type DiscoveryDeps } from "../services/ideas/discovery.js";
import { addManualIdea } from "../services/ideas/manual.js";
import {
  SLOT_STATUSES, SlotTakenError, bookIdea, localDate, logIdeaEvent, parseScheduledFor, slotsBetween, startIdea, type StartRun,
} from "../services/ideas/schedule.js";
import { getIdeaSettings } from "../services/ideas/settings.js";
import { getSiteForUser } from "../services/user-settings.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "approved", "scheduled", "in_progress", "drafted", "rejected", "archived"] as const;
const SORTS = ["score", "newest", "scheduled"] as const;
const MODES = ["normal", "deep"] as const;
const MAX_RANGE_DAYS = 100;

type IdeaRow = typeof ideas.$inferSelect;

export const serializeIdea = (r: IdeaRow) => ({
  id: r.id, siteId: r.siteId, status: r.status, title: r.title, angle: r.angle, primaryKeyword: r.primaryKeyword,
  alternateKeywords: r.alternateKeywords, searchIntent: r.searchIntent, audienceQuestion: r.audienceQuestion,
  brief: r.brief, score: r.score, scoreBreakdown: r.scoreBreakdown, origin: r.origin, discoveryId: r.discoveryId, mode: r.mode,
  scheduledFor: r.scheduledFor, jobId: r.jobId, postId: r.postId, rejectedReason: r.rejectedReason, error: r.error,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

const serializeDiscovery = (r: typeof ideaDiscoveries.$inferSelect) => ({
  id: r.id, siteId: r.siteId, status: r.status, signalCount: r.signalCount, ideaCount: r.ideaCount, costUsd: r.costUsd,
  error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, createdAt: r.createdAt,
});

const validation = (field: string, message: string) => new ApiError(400, "validation_error", `Invalid ${field}`, [{ field, message }]);

/** Trimmed text within a length, or undefined when absent; null clears an optional field. */
function optionalText(body: Record<string, unknown>, field: string, max: number, min = 0): string | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw validation(field, "Expected text");
  const t = v.trim();
  if (t.length > max || t.length < min) throw validation(field, `Expected ${min}-${max} characters`);
  return t || null;
}

async function ownedSite(c: Parameters<typeof getUserId>[0], source: string | undefined | null) {
  const userId = getUserId(c);
  if (!source || !UUID.test(source)) throw validation("siteId", "A site id is required");
  const site = await getSiteForUser(userId, source);
  if (!site) throw new ApiError(404, "not_found", "Site not found");
  return { userId, siteId: site.id };
}

async function ownedIdea(c: Parameters<typeof getUserId>[0]) {
  const userId = getUserId(c);
  const id = c.req.param("id") ?? "";
  const [row] = UUID.test(id) ? await db.select().from(ideas).where(and(eq(ideas.id, id), eq(ideas.userId, userId))).limit(1) : [];
  if (!row) throw new ApiError(404, "not_found", "Idea not found");
  return { userId, idea: row };
}

const conflict = (idea: IdeaRow, action: string) => new ApiError(409, "conflict", `A ${idea.status.replace("_", " ")} idea cannot be ${action}`);

export type IdeasRouteDeps = { startRun?: StartRun; discoveryDeps?: () => Promise<DiscoveryDeps> };

export function createIdeasRoutes(deps: IdeasRouteDeps = {}) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const status = c.req.query("status");
    const wanted = status ? status.split(",").map((s) => s.trim()) : [];
    if (wanted.some((s) => !(STATUSES as readonly string[]).includes(s))) throw validation("status", `Expected any of: ${STATUSES.join(", ")}`);
    const sort = c.req.query("sort") ?? "score";
    if (!(SORTS as readonly string[]).includes(sort)) throw validation("sort", `Expected one of: ${SORTS.join(", ")}`);
    const order = sort === "newest" ? [desc(ideas.createdAt)] : sort === "scheduled" ? [sql`${ideas.scheduledFor} ASC NULLS LAST`, desc(ideas.score)] : [sql`${ideas.score} DESC NULLS LAST`, desc(ideas.createdAt)];
    const rows = await db.select().from(ideas).where(and(
      eq(ideas.userId, userId), eq(ideas.siteId, siteId),
      wanted.length ? inArray(ideas.status, wanted) : ne(ideas.status, "archived"),
    )).orderBy(...order).limit(300);
    return c.json({ items: rows.map(serializeIdea) });
  });

  routes.post("/discover", async (c) => {
    const body = await readJsonObject(c);
    const { userId, siteId } = await ownedSite(c, requiredString(body, "siteId"));
    const queued = await queueDiscovery(userId, siteId);
    const [row] = await db.select().from(ideaDiscoveries).where(and(eq(ideaDiscoveries.id, queued.id), eq(ideaDiscoveries.userId, userId))).limit(1);
    if (queued.created) await logIdeaEvent({ userId, siteId, action: "ideas.discover", status: "queued" });
    return c.json({ discovery: serializeDiscovery(row!), created: queued.created }, 202);
  });

  routes.get("/discoveries", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const rows = await db.select().from(ideaDiscoveries).where(and(eq(ideaDiscoveries.userId, userId), eq(ideaDiscoveries.siteId, siteId)))
      .orderBy(desc(ideaDiscoveries.createdAt)).limit(10);
    return c.json({ items: rows.map(serializeDiscovery) });
  });

  routes.get("/calendar", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const settings = await getIdeaSettings(userId, siteId);
    const parse = (field: string) => {
      const at = parseScheduledFor(c.req.query(field), settings.cadence);
      if (!at) throw validation(field, "Expected an ISO date (YYYY-MM-DD) or timestamp");
      return at;
    };
    const [from, to] = [parse("from"), parse("to")];
    if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw validation("to", `Expected a range of up to ${MAX_RANGE_DAYS} days after from`);
    const rows = await db.select({ idea: ideas, post: { id: posts.id, title: posts.title, status: posts.status } }).from(ideas)
      .leftJoin(posts, and(eq(posts.id, ideas.postId), eq(posts.userId, userId)))
      .where(and(eq(ideas.userId, userId), eq(ideas.siteId, siteId), inArray(ideas.status, [...SLOT_STATUSES]), isNotNull(ideas.scheduledFor), gte(ideas.scheduledFor, from), lt(ideas.scheduledFor, to)))
      .orderBy(asc(ideas.scheduledFor));
    const cadence = slotsBetween(settings.cadence, from, to);
    const byTime = new Map(rows.map((r) => [r.idea.scheduledFor!.getTime(), r]));
    const times = [...new Set([...cadence.map((d) => d.getTime()), ...byTime.keys()])].sort((a, b) => a - b);
    const cadenceSet = new Set(cadence.map((d) => d.getTime()));
    return c.json({
      timezone: settings.cadence.timezone,
      slots: times.map((t) => {
        const hit = byTime.get(t);
        const at = new Date(t);
        return {
          at, localDate: localDate(at, settings.cadence.timezone), isCadenceSlot: cadenceSet.has(t),
          idea: hit ? { id: hit.idea.id, title: hit.idea.title, status: hit.idea.status, score: hit.idea.score, mode: hit.idea.mode, jobId: hit.idea.jobId, error: hit.idea.error } : null,
          post: hit?.post?.id ? hit.post : null,
        };
      }),
    });
  });

  routes.post("/", async (c) => {
    const body = await readJsonObject(c);
    const { userId, siteId } = await ownedSite(c, requiredString(body, "siteId"));
    const title = optionalText(body, "title", 160, 5);
    if (!title) throw validation("title", "Required");
    const row = await addManualIdea({
      userId, siteId, title, angle: optionalText(body, "angle", 500), primaryKeyword: optionalText(body, "primaryKeyword", 80), deps: deps.discoveryDeps,
    });
    await logIdeaEvent({ userId, siteId, action: "ideas.create", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) }, 201);
  });

  /** The editable fields shared by PATCH and approve. */
  function readEdits(body: Record<string, unknown>) {
    const edits: Partial<typeof ideas.$inferInsert> = {};
    const title = optionalText(body, "title", 160, 5);
    if (title === null) throw validation("title", "Cannot be empty");
    if (title !== undefined) edits.title = title;
    const angle = optionalText(body, "angle", 500);
    if (angle !== undefined) edits.angle = angle;
    const keyword = optionalText(body, "primaryKeyword", 80);
    if (keyword !== undefined) edits.primaryKeyword = keyword;
    if (body.alternateKeywords !== undefined) {
      const k = body.alternateKeywords;
      if (!Array.isArray(k) || k.length > 6 || k.some((x) => typeof x !== "string" || !x.trim() || x.length > 80)) throw validation("alternateKeywords", "Expected up to 6 short phrases");
      edits.alternateKeywords = (k as string[]).map((x) => x.trim());
    }
    if (body.mode !== undefined) {
      if (!(MODES as readonly unknown[]).includes(body.mode)) throw validation("mode", `Expected one of: ${MODES.join(", ")}`);
      edits.mode = body.mode as "normal" | "deep";
    }
    let outline: string[] | undefined;
    if (body.outline !== undefined) {
      const o = body.outline;
      if (!Array.isArray(o) || o.length < 3 || o.length > 6 || o.some((x) => typeof x !== "string" || !x.trim() || x.length > 120)) throw validation("outline", "Expected 3-6 headings");
      outline = (o as string[]).map((x) => x.trim());
    }
    return { edits, outline };
  }

  const withOutline = (idea: IdeaRow, outline?: string[]) => (outline ? { brief: { ...(idea.brief as object), outline } } : {});

  routes.patch("/:id", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    if (idea.status !== "new" && idea.status !== "scheduled") throw conflict(idea, "edited");
    const { edits, outline } = readEdits(await readJsonObject(c));
    const [row] = await db.update(ideas).set({ ...edits, ...withOutline(idea, outline), updatedAt: new Date() })
      .where(and(eq(ideas.id, idea.id), eq(ideas.userId, userId), inArray(ideas.status, ["new", "scheduled"]))).returning();
    if (!row) throw conflict(idea, "edited");
    await logIdeaEvent({ userId, siteId: row.siteId, action: "ideas.edit", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  });

  /** The date the owner picked, or undefined for the next free slot. */
  async function pickedDate(body: Record<string, unknown>, userId: string, siteId: string, required: boolean) {
    if (body.scheduledFor === undefined || body.scheduledFor === null) {
      if (required) throw validation("scheduledFor", "Required");
      return { settings: await getIdeaSettings(userId, siteId), at: undefined };
    }
    const settings = await getIdeaSettings(userId, siteId);
    const at = parseScheduledFor(body.scheduledFor, settings.cadence);
    if (!at) throw validation("scheduledFor", "Expected an ISO date (YYYY-MM-DD) or timestamp");
    if (at.getTime() <= Date.now()) throw validation("scheduledFor", "Must be in the future");
    return { settings, at };
  }

  const book = async (c: Parameters<typeof getUserId>[0], action: "approve" | "reschedule") => {
    const { userId, idea } = await ownedIdea(c);
    const from = action === "approve" ? ["new"] : ["scheduled"];
    if (!from.includes(idea.status)) throw conflict(idea, action === "approve" ? "approved" : "rescheduled");
    const body = await readJsonObject(c);
    const { edits, outline } = action === "approve" ? readEdits(body) : { edits: {}, outline: undefined };
    const { settings, at } = await pickedDate(body, userId, idea.siteId, action === "reschedule");
    let row: IdeaRow | null;
    try {
      row = await bookIdea({ userId, siteId: idea.siteId, ideaId: idea.id, settings, from, scheduledFor: at, edits: { ...edits, ...withOutline(idea, outline) } });
    } catch (error) {
      if (error instanceof SlotTakenError) throw new ApiError(409, "conflict", error.message);
      throw error;
    }
    if (!row) throw conflict(idea, action === "approve" ? "approved" : "rescheduled");
    await logIdeaEvent({ userId, siteId: row.siteId, action: `ideas.${action}`, ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  };
  routes.post("/:id/approve", (c) => book(c, "approve"));
  routes.post("/:id/reschedule", (c) => book(c, "reschedule"));

  routes.post("/:id/reject", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const reason = optionalText(body && typeof body === "object" ? body : {}, "reason", 500);
    const [row] = await db.update(ideas).set({ status: "rejected", rejectedReason: reason ?? null, scheduledFor: null, updatedAt: new Date() })
      .where(and(eq(ideas.id, idea.id), eq(ideas.userId, userId), inArray(ideas.status, ["new", "scheduled"]))).returning();
    if (!row) throw conflict(idea, "rejected");
    await logIdeaEvent({ userId, siteId: row.siteId, action: "ideas.reject", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  });

  routes.post("/:id/archive", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    const [row] = await db.update(ideas).set({ status: "archived", scheduledFor: null, updatedAt: new Date() })
      .where(and(eq(ideas.id, idea.id), eq(ideas.userId, userId), inArray(ideas.status, ["new", "rejected", "drafted"]))).returning();
    if (!row) throw conflict(idea, "archived");
    await logIdeaEvent({ userId, siteId: row.siteId, action: "ideas.archive", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  });

  routes.post("/:id/write-now", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    let started;
    try {
      started = await startIdea(userId, idea.siteId, idea.id, deps.startRun);
    } catch (error) {
      if (error instanceof EngineUnavailableError) throw new ApiError(503, "service_unavailable", error.message);
      if (error instanceof StageInputError) throw new ApiError(400, "validation_error", error.message);
      throw error;
    }
    if (!started) throw conflict(idea, "started");
    await logIdeaEvent({ userId, siteId: idea.siteId, action: "ideas.write_now", ideaId: idea.id, status: "in_progress" });
    return c.json({ idea: serializeIdea(started.idea), run: started.run });
  });

  return routes;
}

export const ideasRoutes = createIdeasRoutes();
