import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { articleGateResults, posts, sites } from "../../../db/schema.js";
import { safeFetch } from "../../../services/safe-fetch.js";
import { ENGINE_CONFIG } from "../../config.js";
import { gateBlockers, type GateInput } from "../../gates/types.js";
import { runCodeGates } from "../../gates/index.js";
import type { Stage } from "../../runtime/stage.js";
import { StageInputError } from "../../types.js";
import { truncate } from "../../util.js";
import type { DraftOutput } from "../draft/schema.js";
import { findStageOutput, latestDraft, renderArticle, runSettings } from "../shared.js";
import type { GatesOutput } from "./schema.js";

export type GatesInput = { draft: DraftOutput; previousBlockers: number | null; reviseCount: number };

const LINK_TIMEOUT_MS = 10_000;
const EXISTING_POSTS_CAP = 200;
const REASON_MAX = 280;

/**
 * The status a source link answers with: HEAD, then GET when the server refuses HEAD. 0 means no
 * connection (DNS, SSRF guard, redirects); a timeout is 408, which the gate treats as unconfirmed.
 */
export async function checkLink(url: string, signal?: AbortSignal, fetchImpl: typeof safeFetch = safeFetch): Promise<number> {
  const status = async (method: "HEAD" | "GET") => {
    const res = await fetchImpl(url, { method, signal, timeoutMs: LINK_TIMEOUT_MS, maxResponseBytes: 64_000 });
    await res.body?.cancel().catch(() => {});
    return res.status;
  };
  let head: number;
  try {
    head = await status("HEAD");
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    return (err as { name?: string })?.name === "TimeoutError" ? 408 : 0;
  }
  if (![403, 405, 501].includes(head)) return head;
  try {
    return await status("GET");
  } catch {
    return head;
  }
}

const siteUrlOf = (domain: string) => (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);

export const gatesStage: Stage<GatesInput, GatesOutput> = {
  key: "gates",
  promptVersion: "gates@2026-11-03.1",
  async input({ run }) {
    const [draft, previous] = await Promise.all([latestDraft(run), findStageOutput<GatesOutput>(run, "gates")]);
    return { draft, previousBlockers: previous?.output.blockerCount ?? null, reviseCount: run.reviseCount };
  },
  async run(input, ctx) {
    const { run } = ctx;
    const [site] = await db.select({ domain: sites.domain }).from(sites).where(and(eq(sites.id, run.siteId), eq(sites.userId, run.userId))).limit(1);
    if (!site) throw new StageInputError("Site no longer exists");
    const [rendered, existingPosts] = await Promise.all([
      renderArticle(run, input.draft.markdown, true),
      db.select({ id: posts.id, title: posts.title, content: posts.content })
        .from(posts)
        .where(and(eq(posts.userId, run.userId), eq(posts.siteId, run.siteId)))
        .orderBy(desc(posts.createdAt))
        .limit(EXISTING_POSTS_CAP),
    ]);
    const gateInput: GateInput = {
      title: input.draft.title,
      description: input.draft.description,
      raw: input.draft.markdown,
      markdown: rendered.markdown,
      evidence: rendered.evidence,
      sources: rendered.sources,
      siteUrl: siteUrlOf(site.domain),
      existingPosts,
    };
    const results = await runCodeGates(gateInput, { config: ENGINE_CONFIG, checkLink, signal: ctx.signal });

    // A retried attempt replaces its own rows; the attempt number is unique per run and stage.
    await db.transaction(async (tx) => {
      const where = and(eq(articleGateResults.runId, run.id), eq(articleGateResults.userId, run.userId), eq(articleGateResults.attempt, ctx.attempt));
      await tx.delete(articleGateResults).where(where);
      await tx.insert(articleGateResults).values(results.map((r) => ({
        runId: run.id, userId: run.userId, attempt: ctx.attempt, gate: r.gate, passed: r.passed, severity: r.severity, issues: r.issues, metrics: r.metrics ?? {},
      })));
    });

    const blockers = gateBlockers(results);
    const warningCount = results.filter((r) => !r.passed && r.severity === "warning").reduce((n, r) => n + r.issues.length, 0);
    const base = { blockerCount: blockers.length, warningCount, blockers };
    if (blockers.length === 0) {
      return { next: { type: "advance", to: "deliver" }, output: { ...base, passed: true, escalated: false, reason: null } };
    }
    // Stop when the last revision did not shrink the blocker list, or the mode's revise loops are spent.
    const stalled = input.previousBlockers !== null && blockers.length >= input.previousBlockers;
    if (input.reviseCount < runSettings(run).preset.maxRevise && !stalled) {
      return { next: { type: "advance", to: "revise" }, output: { ...base, passed: false, escalated: false, reason: null } };
    }
    const reason = truncate(`Gates still failing: ${blockers.slice(0, 3).map((b) => `${b.gate}: ${b.message}`).join("; ")}`, REASON_MAX);
    return { next: { type: "advance", to: "deliver" }, output: { ...base, passed: false, escalated: true, reason } };
  },
};
