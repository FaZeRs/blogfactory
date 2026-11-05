import { db } from "../../db/index.js";
import { ideas } from "../../db/schema.js";
import { generateCandidates, type Candidate } from "./candidates.js";
import { fetchKeywordMetrics, loadDiscoveryDeps, readExistingContent, scoreCandidates, type DiscoveryDeps } from "./discovery.js";
import { getIdeaSettings } from "./settings.js";
import { getEffectiveSettings, getSiteForUser } from "../user-settings.js";

/**
 * Adds an idea the owner typed and rates it with one enrich-and-rating model call. The owner's title, angle and keyword
 * are kept; the model supplies the ratings, outline and why-now. Without a model (no key, call failed) the idea is saved unscored.
 */
export async function addManualIdea(input: {
  userId: string; siteId: string; title: string; angle?: string | null; primaryKeyword?: string | null;
  deps?: () => Promise<DiscoveryDeps>;
}) {
  const { userId, siteId } = input;
  const site = await getSiteForUser(userId, siteId);
  if (!site) throw new Error("Site not found");
  const settings = await getIdeaSettings(userId, siteId);
  let rated: ReturnType<typeof scoreCandidates>[number] | null = null;
  try {
    const effective = await getEffectiveSettings(userId, siteId);
    const deps = await (input.deps ? input.deps() : loadDiscoveryDeps(userId, effective.engineSettings));
    const existing = await readExistingContent(userId, siteId, site.internalLinkIndex);
    const signal = { id: "s1", source: "rss" as const, title: input.title, summary: input.angle ?? "" };
    const gen = await generateCandidates({
      llm: deps.llm, model: deps.model, max: 1, signals: [signal], postTitles: existing.map((p) => p.title),
      site: { name: site.name, domain: site.domain, language: site.language, topics: site.topics ?? [], description: effective.brandDescription, audience: effective.brandTargetAudience },
    });
    const base: Candidate | undefined = gen.candidates[0];
    if (base) {
      const candidate: Candidate = { ...base, title: input.title, angle: input.angle || base.angle, primaryKeyword: input.primaryKeyword || base.primaryKeyword, signalIds: [] };
      const metrics = await fetchKeywordMetrics({ dataForSeo: deps.dataForSeo, locale: (/^[a-z]{2}/i.exec(site.language ?? "")?.[0] ?? "en").toLowerCase(), keywords: [candidate.primaryKeyword], signals: [] });
      rated = scoreCandidates({ candidates: [candidate], signals: [], metrics, existingPosts: existing, existingIdeaTitles: [], weights: settings.weights, now: new Date() })[0] ?? null;
    }
  } catch {
    rated = null;
  }
  const c = rated?.candidate;
  const [row] = await db.insert(ideas).values({
    userId, siteId, status: "new", origin: "manual", mode: settings.defaultMode,
    title: input.title, angle: input.angle || c?.angle || null, primaryKeyword: input.primaryKeyword || c?.primaryKeyword || null,
    alternateKeywords: c?.alternateKeywords ?? [], searchIntent: c?.searchIntent || rated?.keyword?.intent || null, audienceQuestion: c?.audienceQuestion || null,
    brief: c ? { whyNow: c.whyNow, outline: c.outline, informationGain: c.informationGain, sources: [], suggestedMode: "normal" } : {},
    score: rated?.score ?? null,
    scoreBreakdown: rated && c ? { ...rated.factors, keyword: rated.keyword, nearestPost: rated.nearest, rationale: c.rationale } : null,
  }).returning();
  return row!;
}
