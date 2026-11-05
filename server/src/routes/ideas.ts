import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { ideaDiscoveries, ideas, posts } from "../db/schema.js";
import { EngineUnavailableError } from "../engine/article-runs.js";
import { StageInputError } from "../engine/types.js";
import { ApiError, readJsonObject, requiredString } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { queueDiscovery, type DiscoveryDeps } from "../services/ideas/discovery.js";
import {
  IdeaActionError, bookOwnedIdea, listIdeas, optionalText, ownedIdeaRow, readExpectedUpdatedAt, readIdeaEdits, rejectOwnedIdea, sameVersion, staleVersion, serializeDiscovery, serializeIdea, withOutline,
  type IdeaRow,
} from "../services/ideas/actions.js";
import { addManualIdea } from "../services/ideas/manual.js";
import {
  SLOT_STATUSES, localDate, logIdeaEvent, parseScheduledFor, slotsBetween, startIdea, type StartRun,
} from "../services/ideas/schedule.js";
import { getIdeaSettings } from "../services/ideas/settings.js";
import { getSiteForUser } from "../services/user-settings.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RANGE_DAYS = 100;

const validation = (field: string, message: string) => new ApiError(400, "validation_error", `Invalid ${field}`, [{ field, message }]);

async function ownedSite(c: Parameters<typeof getUserId>[0], source: string | undefined | null) {
  const userId = getUserId(c);
  if (!source || !UUID.test(source)) throw validation("siteId", "A site id is required");
  const site = await getSiteForUser(userId, source);
  if (!site) throw new ApiError(404, "not_found", "Site not found");
  return { userId, siteId: site.id };
}

/** Service errors become the route's HTTP errors. */
async function api<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof IdeaActionError)) throw e;
    if (e.kind === "validation") throw validation(e.field ?? "body", e.message);
    throw new ApiError(e.kind === "not_found" ? 404 : 409, e.kind, e.message);
  }
}

async function ownedIdea(c: Parameters<typeof getUserId>[0]) {
  const userId = getUserId(c);
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) throw new ApiError(404, "not_found", "Idea not found");
  return { userId, idea: await api(() => ownedIdeaRow(userId, id)) };
}

const conflict = (idea: IdeaRow, action: string) => new ApiError(409, "conflict", `A ${idea.status.replace("_", " ")} idea cannot be ${action}`);

export type IdeasRouteDeps = { startRun?: StartRun; discoveryDeps?: () => Promise<DiscoveryDeps> };

export function createIdeasRoutes(deps: IdeasRouteDeps = {}) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const { userId, siteId } = await ownedSite(c, c.req.query("siteId"));
    const status = c.req.query("status");
    const rows = await api(() => listIdeas({ userId, siteId, statuses: status ? status.split(",").map((s) => s.trim()) : [], sort: c.req.query("sort") }));
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
    // A range day starts at local midnight, not at the cadence time, so a slot booked earlier that day is in its month.
    const parse = (field: string) => {
      const at = parseScheduledFor(c.req.query(field), { ...settings.cadence, time: "00:00" });
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
    const fields = await api(async () => ({ title: optionalText(body, "title", 160, 5), angle: optionalText(body, "angle", 500), primaryKeyword: optionalText(body, "primaryKeyword", 80) }));
    if (!fields.title) throw validation("title", "Required");
    const row = await addManualIdea({ userId, siteId, ...fields, title: fields.title, deps: deps.discoveryDeps });
    await logIdeaEvent({ userId, siteId, action: "ideas.create", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) }, 201);
  });

  routes.patch("/:id", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    if (idea.status !== "new" && idea.status !== "scheduled") throw conflict(idea, "edited");
    const body = await readJsonObject(c);
    const { edits, outline, expected } = await api(async () => ({ ...readIdeaEdits(body), expected: readExpectedUpdatedAt(body, true)! }));
    if (idea.updatedAt.getTime() !== expected.getTime()) await api(async () => { throw staleVersion(); });
    const [row] = await db.update(ideas).set({ ...edits, ...withOutline(idea, outline), updatedAt: new Date(Math.max(Date.now(), idea.updatedAt.getTime() + 1)) })
      .where(and(eq(ideas.id, idea.id), eq(ideas.userId, userId), inArray(ideas.status, ["new", "scheduled"]), ...sameVersion(expected))).returning();
    if (!row) await api(async () => { throw staleVersion(); });
    await logIdeaEvent({ userId, siteId: row.siteId, action: "ideas.edit", ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  });

  const book = async (c: Parameters<typeof getUserId>[0], action: "approve" | "reschedule") => {
    const userId = getUserId(c);
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new ApiError(404, "not_found", "Idea not found");
    const row = await api(async () => bookOwnedIdea({ userId, ideaId: id, action, body: await readJsonObject(c) }));
    await logIdeaEvent({ userId, siteId: row.siteId, action: `ideas.${action}`, ideaId: row.id, status: row.status });
    return c.json({ idea: serializeIdea(row) });
  };
  routes.post("/:id/approve", (c) => book(c, "approve"));
  routes.post("/:id/reschedule", (c) => book(c, "reschedule"));

  routes.post("/:id/reject", async (c) => {
    const { userId, idea } = await ownedIdea(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const reason = await api(async () => optionalText(body && typeof body === "object" ? body : {}, "reason", 500));
    const row = await api(() => rejectOwnedIdea({ userId, ideaId: idea.id, reason }));
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
      started = await startIdea(userId, idea.siteId, idea.id, deps.startRun, new Date(), true);
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
