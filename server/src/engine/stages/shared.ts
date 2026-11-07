import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleEvidence, articleSources, articleStageRuns, posts } from "../../db/schema.js";
import { renderCitations } from "../citations.js";
import type { EvidenceItem, SourceItem } from "../gates/types.js";
import { resolveRunSettings, parseEngineSettings } from "../modes.js";
import type { ArticleRunRow } from "../runtime/stage.js";
import { StageInputError, type EngineMode, type ModelRole, type StageKey } from "../types.js";
import type { DraftOutput } from "./draft/schema.js";
import type { ResearchOutput } from "./research/schema.js";
import { buildBrandContextLines } from "../../services/generation-contracts.js";
import { buildVoiceContentInstructions } from "../../services/voice-content.js";
import { activeLocales, getLocalization } from "../../services/localization/settings.js";

export const runSettings = (run: ArticleRunRow) => resolveRunSettings(run.mode as EngineMode, parseEngineSettings(run.settings));
export const modelFor = (run: ArticleRunRow, role: ModelRole) => runSettings(run).models[role];

/** The stored `.output.output` of the latest succeeded or reused row of the given stages; user- and run-scoped. */
export async function findStageOutput<T>(run: ArticleRunRow, ...stages: StageKey[]): Promise<{ stage: StageKey; output: T } | null> {
  const [row] = await db
    .select({ stage: articleStageRuns.stage, output: articleStageRuns.output })
    .from(articleStageRuns)
    .where(and(
      eq(articleStageRuns.runId, run.id),
      eq(articleStageRuns.userId, run.userId),
      inArray(articleStageRuns.stage, stages),
      inArray(articleStageRuns.status, ["succeeded", "reused"]),
    ))
    .orderBy(desc(articleStageRuns.startedAt), desc(articleStageRuns.attempt))
    .limit(1);
  const stored = row?.output as { output?: T } | null | undefined;
  return stored?.output ? { stage: row!.stage as StageKey, output: stored.output } : null;
}

export async function latestStageOutput<T>(run: ArticleRunRow, stage: StageKey): Promise<T> {
  const found = await findStageOutput<T>(run, stage);
  if (!found) throw new StageInputError(`No ${stage} output for this run`);
  return found.output;
}

/** The article as it stands: the revise output when a revision ran, otherwise the draft. */
export async function latestDraft(run: ArticleRunRow): Promise<DraftOutput> {
  const found = await findStageOutput<DraftOutput>(run, "draft", "revise");
  if (!found) throw new StageInputError("No draft output for this run");
  return found.output;
}

/** Sources without page text (ids and URLs only), for prompts and citation rendering. */
export async function loadSources(run: ArticleRunRow, withMarkdown = false): Promise<SourceItem[]> {
  const rows = await db
    .select()
    .from(articleSources)
    .where(and(eq(articleSources.runId, run.id), eq(articleSources.userId, run.userId), eq(articleSources.kind, "evidence")));
  return rows.map((s) => ({
    id: s.id,
    url: s.url,
    finalUrl: s.finalUrl ?? s.url,
    title: s.title,
    markdown: withMarkdown ? (s.markdown ?? "") : "",
  }));
}

/** Evidence as the gates and citations read it: `id` is the claim id (`c1`) the draft cites. */
export async function loadEvidence(run: ArticleRunRow): Promise<EvidenceItem[]> {
  const research = await latestStageOutput<ResearchOutput>(run, "research");
  const rows = await db
    .select()
    .from(articleEvidence)
    .where(and(eq(articleEvidence.runId, run.id), eq(articleEvidence.userId, run.userId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return research.claims.flatMap((c) => {
    const r = byId.get(c.evidenceId);
    return r ? [{ id: c.claimId, claim: r.claim, quote: r.quote, sourceId: r.sourceId, verified: r.verified }] : [];
  });
}

export type PromptEvidence = { id: string; claim: string; quote: string; url: string };
export const evidenceText = (rows: PromptEvidence[]) =>
  rows.map((e) => `[${e.id}] ${e.claim}\n    quote: "${e.quote}"\n    source: ${e.url}`).join("\n");

/** Internal link candidates come from the site's link index only. */
export type LinkCandidate = { url: string; title: string };
export const linksText = (links: LinkCandidate[]) => (links.length ? links.map((l) => `- ${l.url} — ${l.title}`).join("\n") : "None.");

/** Models sometimes wrap the article in a code fence or repeat the title as an H1. */
/**
 * Some models flatten a long JSON string's line breaks into runs of spaces, which hides every heading and list.
 * Real Markdown of this length has a line break every few hundred characters, so an article with almost none is
 * repaired: each run of 2+ spaces becomes a paragraph break.
 */
export function unflattenMarkdown(text: string): string {
  const breaks = (text.match(/\n/g) ?? []).length;
  if (text.length < 1500 || breaks > text.length / 600) return text;
  return text.replace(/ {2,}(?=\S)/g, "\n\n");
}

/**
 * Some models answer a Markdown request with HTML blocks. With 3 or more paragraph or heading tags the basic tags are
 * converted; capitalised component tags (Lindevo's) and anything else are left alone.
 */
export function htmlBlocksToMarkdown(input: string): string {
  // Code examples are set aside first, so HTML shown inside a fence or inline code is never converted.
  const code: string[] = [];
  const text = input.replace(/(`{3,}|~{3,})[\s\S]*?\1|`[^`\n]+`/g, (m) => `\u0000${code.push(m) - 1}\u0000`);
  const restore = (out: string) => out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]!);
  if ((text.match(/<(?:p|h[1-6])\b[^>]*>/g) ?? []).length < 3) return input;
  const inline = (t: string) => t.trim()
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, "*$2*")
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)");
  const items = (list: string, marker: (i: number) => string) =>
    [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m, i) => `${marker(i)} ${inline(m[1]!)}`).join("\n");
  return restore(text
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/g, (_, list: string) => `\n\n${items(list, (i) => `${i + 1}.`)}\n\n`)
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/g, (_, list: string) => `\n\n${items(list, () => "-")}\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${inline(t)}\n\n`)
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/g, (_, t: string) => `\n\n${inline(t)}\n\n`)
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

export function normalizeDraftMarkdown(md: string): string {
  let text = md.replace(/\r\n/g, "\n").trim();
  // Unwrap a whole-article fence first: the HTML repair leaves fenced code alone.
  const wrapped = /^(`{3,}|~{3,})(?:markdown|md|mdx)?[ \t]*\n([\s\S]*)\n\1[ \t]*$/i.exec(text);
  if (wrapped) text = wrapped[2]!;
  text = unflattenMarkdown(htmlBlocksToMarkdown(text.trim()));
  return `${text.replace(/^\s*# [^\n]*\n+/, "").trim()}\n`;
}

/** The draft as readers see it: citations rendered from the run's own evidence and sources. */
export async function renderArticle(run: ArticleRunRow, raw: string, withSourceText = false) {
  const [evidence, sources] = await Promise.all([loadEvidence(run), loadSources(run, withSourceText)]);
  return { evidence, sources, markdown: renderCitations(raw, evidence, sources, runSettings(run).citationStyle, run.locale) };
}

/**
 * The writer's voice rules and the site's brand profile (company, audience, value propositions, CTAs, and the saved
 * knowledge most relevant to the topic), one instruction per line.
 */
export function writerVoice(settings: Record<string, unknown>, topic: string): string {
  const brand = buildBrandContextLines(settings as never, topic);
  return [...buildVoiceContentInstructions(settings as never), ...(brand.length ? ["Brand context:", ...brand.map((l) => `- ${l}`)] : [])].join("\n");
}

/** A passed article is localized before delivery only when its site has localization on with a locale; otherwise it is delivered. */
export async function afterChecks(run: ArticleRunRow): Promise<"localize" | "deliver"> {
  return activeLocales(await getLocalization(run.userId, run.siteId)).length ? "localize" : "deliver";
}

const CURRENT_MAX = 30_000;
export const NO_CURRENT = "None: this is a new article.";

/** For a refresh run, the post it updates (title and body, user- and site-scoped); "" for a new article. */
export async function refreshCurrentText(run: ArticleRunRow): Promise<string> {
  const id = (run.settings as { refreshPostId?: unknown } | null)?.refreshPostId;
  if (typeof id !== "string") return "";
  const [post] = await db.select({ title: posts.title, content: posts.content }).from(posts)
    .where(and(eq(posts.id, id), eq(posts.userId, run.userId), eq(posts.siteId, run.siteId))).limit(1);
  return post ? `Title: ${post.title}\n\n${post.content.slice(0, CURRENT_MAX)}` : "";
}
