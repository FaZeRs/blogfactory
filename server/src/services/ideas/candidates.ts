import { z } from "zod";
import type { EngineLlm } from "../../engine/adapters/llm.js";
import { DATA_RULE, fenceData, preparePrompt } from "../../engine/prompts/load.js";
import { sanitizeText, truncate } from "../../engine/util.js";
import type { Signal } from "./signals.js";

export const MAX_CANDIDATES = 20;

const text = (max: number) => z.string().transform((s) => truncate(sanitizeText(s).replace(/\s+/g, " ").trim(), max));
const rating = z.number().min(0).max(10);

export const CandidateSchema = z.object({
  title: text(160).pipe(z.string().min(5)),
  angle: text(500).default(""),
  primaryKeyword: text(80).pipe(z.string().min(2)),
  alternateKeywords: z.array(text(80)).max(6).default([]).catch([]),
  searchIntent: text(40).default(""),
  audienceQuestion: text(300).default(""),
  whyNow: text(400).default(""),
  outline: z.array(text(120).pipe(z.string().min(1))).min(3).max(6),
  informationGain: z.array(text(300)).max(4).default([]).catch([]),
  signalIds: z.array(z.string()).max(30).default([]).catch([]),
  fit: rating,
  gain: rating,
  demandEstimate: rating,
  rationale: text(400).default(""),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** The model reply is only checked for shape here; each idea is validated alone so one bad idea does not drop the rest. */
const ReplySchema = z.object({ ideas: z.array(z.unknown()).max(60) });

export function parseCandidates(raw: unknown[], signals: Pick<Signal, "id">[]): Candidate[] {
  const known = new Set(signals.map((s) => s.id));
  const out: Candidate[] = [];
  for (const item of raw) {
    const parsed = CandidateSchema.safeParse(item);
    if (parsed.success) out.push({ ...parsed.data, signalIds: parsed.data.signalIds.filter((id) => known.has(id)) });
  }
  return out.slice(0, MAX_CANDIDATES);
}

export type SiteContext = { name: string; domain: string; language?: string | null; topics: string[]; description?: string | null; audience?: string | null };

export async function generateCandidates(input: {
  llm: EngineLlm;
  model: string;
  site: SiteContext;
  postTitles: string[];
  signals: Signal[];
  /** How many ideas to ask for; defaults to MAX_CANDIDATES. */
  max?: number;
  signal?: AbortSignal;
}): Promise<{ candidates: Candidate[]; costUsd: number; model: string }> {
  const site = [
    `Name: ${input.site.name}`, `Domain: ${input.site.domain}`,
    input.site.language ? `Language: ${input.site.language}` : "",
    `Topics: ${input.site.topics.join(", ") || "none given"}`,
    input.site.description ? `About: ${truncate(input.site.description, 600)}` : "",
    input.site.audience ? `Audience: ${truncate(input.site.audience, 300)}` : "",
  ].filter(Boolean).join("\n");
  const signals = input.signals.map((s) => `${s.id} | ${s.source} | ${s.title} | ${s.summary}`).join("\n");
  const prompt = await preparePrompt("ideas-candidates", {
    dataRule: DATA_RULE,
    max: input.max ?? MAX_CANDIDATES,
    site: fenceData("site", site),
    posts: fenceData("posts", input.postTitles.slice(0, 200).map((t) => `- ${t}`).join("\n") || "(none)"),
    signals: fenceData("signals", signals || "(none)"),
  });
  const res = await input.llm.json({
    role: "brief",
    model: input.model,
    system: prompt.system,
    user: prompt.user,
    schema: ReplySchema,
    maxTokens: 8000,
    signal: input.signal,
  });
  return { candidates: parseCandidates(res.value.ideas, input.signals), costUsd: res.costUsd, model: res.model };
}
