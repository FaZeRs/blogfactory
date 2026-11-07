import { BUILT_IN_SOURCES, SEEN_LINKS_LIMIT, type BuiltInSource } from "./signals.js";
import { getEffectiveSettings, updateSiteSettings } from "../user-settings.js";

export const SCORE_FACTORS = ["trend", "fit", "demand", "feasibility", "novelty", "gain"] as const;
export type ScoreFactor = typeof SCORE_FACTORS[number];
export type ScoreWeights = Record<ScoreFactor, number>;

/** Where discovery looks besides Search Console and the site's own feeds. */
export type IdeaSources = {
  /** Idea-only feeds; they never generate articles. */
  feeds: string[];
  hn: { queries: string[]; minPoints: number };
  /** Subreddit names without "r/". */
  subreddits: string[];
  /** `pattern` is a plain substring of the link URL, not a regex. */
  pages: { url: string; pattern?: string }[];
  /** Built-in sources the owner switched off; discovery skips them. */
  off: BuiltInSource[];
  /** Links already seen per page URL (the baseline); written by discovery only. */
  seen: Record<string, string[]>;
};

export type IdeaSettings = {
  /** Weekdays use JS numbering: 0 Sunday ... 6 Saturday. */
  cadence: { weekdays: number[]; time: string; timezone: string };
  leadDays: number;
  defaultMode: "normal" | "deep";
  autopilot: { enabled: boolean; approvePerWeek: number; minScore: number };
  weights: ScoreWeights;
  /** Extra seed topics; the site's own topics are added when discovery runs. */
  seedTopics: string[];
  /** Competitor domains whose sitemaps are scanned for new pages. */
  competitors: string[];
  sources: IdeaSources;
  /** Monthly weight learning from search results; off freezes the weights. */
  learnWeights: boolean;
  /** UTC month (YYYY-MM) the weights last moved; written by learning only. */
  weightsLearnedMonth: string | null;
  /** The last 24 learning runs; written by learning only. */
  weightHistory: WeightHistoryEntry[];
};

export type WeightHistoryEntry = { month: string; weights: ScoreWeights; samples: number };
export const WEIGHT_HISTORY_LIMIT = 24;

export const DEFAULT_WEIGHTS: ScoreWeights = { trend: 1, fit: 1, demand: 1, feasibility: 1, novelty: 1, gain: 1 };

export const DEFAULT_IDEA_SETTINGS: IdeaSettings = {
  cadence: { weekdays: [1, 4], time: "08:00", timezone: "UTC" },
  leadDays: 3,
  defaultMode: "normal",
  autopilot: { enabled: false, approvePerWeek: 2, minScore: 60 },
  weights: DEFAULT_WEIGHTS,
  seedTopics: [],
  competitors: [],
  sources: { feeds: [], hn: { queries: [], minPoints: 20 }, subreddits: [], pages: [], off: [], seen: {} },
  learnWeights: true,
  weightsLearnedMonth: null,
  weightHistory: [],
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const strings = (v: unknown, max: number, len: number) =>
  Array.isArray(v) ? [...new Set(v.flatMap((x) => typeof x === "string" && x.trim() ? [x.trim().slice(0, len)] : []))].slice(0, max) : [];

/** "https://www.Example.com/path" becomes "example.com"; null when it is not a plain domain name. */
export function bareDomain(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const host = v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "");
  return host.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? host : null;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && v.trim().length <= 500 ? u.toString() : null;
  } catch { return null; }
};

function sourcesOf(raw: unknown): IdeaSources {
  const r = obj(raw);
  const hn = obj(r.hn);
  const pages: IdeaSources["pages"] = [];
  for (const p of Array.isArray(r.pages) ? r.pages : []) {
    const url = httpUrl(obj(p).url);
    const pattern = typeof obj(p).pattern === "string" ? (obj(p).pattern as string).trim().slice(0, 100) : "";
    if (url && !pages.some((x) => x.url === url) && pages.length < 10) pages.push(pattern ? { url, pattern } : { url });
  }
  const seen: IdeaSources["seen"] = {};
  const rawSeen = obj(r.seen);
  for (const { url } of pages) if (Array.isArray(rawSeen[url])) seen[url] = strings(rawSeen[url], SEEN_LINKS_LIMIT, 500);
  return {
    feeds: [...new Set(strings(r.feeds, 40, 500).flatMap((u) => httpUrl(u) ?? []))].slice(0, 20),
    hn: { queries: strings(hn.queries, 10, 80), minPoints: int(hn.minPoints, 0, 1000, DEFAULT_IDEA_SETTINGS.sources.hn.minPoints) },
    subreddits: [...new Set(strings(r.subreddits, 20, 30).flatMap((n) => { const name = n.replace(/^\/?r\//i, ""); return /^[A-Za-z0-9_]{2,21}$/.test(name) ? [name] : []; }))].slice(0, 10),
    pages,
    off: BUILT_IN_SOURCES.filter((s) => Array.isArray(r.off) && r.off.includes(s)),
    seen,
  };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function weightsOf(raw: unknown): ScoreWeights {
  const w = obj(raw);
  const weights = { ...DEFAULT_WEIGHTS };
  for (const f of SCORE_FACTORS) {
    const n = w[f];
    // 3 is learning's MAX_WEIGHT and the form's max, so a monthly nudge never cuts an owner's weight.
    if (typeof n === "number" && Number.isFinite(n)) weights[f] = Math.min(3, Math.max(0, n));
  }
  return weights;
}

/** Any stored or submitted value in, a complete valid settings object out. Never throws. */
export function normalizeIdeaSettings(raw: unknown): IdeaSettings {
  const d = DEFAULT_IDEA_SETTINGS;
  const r = obj(raw);
  const cad = obj(r.cadence);
  const weekdays = Array.isArray(cad.weekdays)
    ? [...new Set(cad.weekdays.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [];
  const auto = obj(r.autopilot);
  const history: WeightHistoryEntry[] = Array.isArray(r.weightHistory)
    ? r.weightHistory.flatMap((e) => {
      const h = obj(e);
      return typeof h.month === "string" && MONTH.test(h.month) && typeof h.samples === "number"
        ? [{ month: h.month, weights: weightsOf(h.weights), samples: Math.max(0, Math.round(h.samples)) }] : [];
    }).slice(-WEIGHT_HISTORY_LIMIT)
    : [];
  return {
    cadence: {
      weekdays: weekdays.length ? weekdays : d.cadence.weekdays,
      time: typeof cad.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(cad.time) ? cad.time : d.cadence.time,
      timezone: isValidTimezone(cad.timezone) ? cad.timezone : d.cadence.timezone,
    },
    leadDays: int(r.leadDays, 0, 30, d.leadDays),
    defaultMode: r.defaultMode === "deep" ? "deep" : "normal",
    autopilot: {
      enabled: auto.enabled === true,
      approvePerWeek: int(auto.approvePerWeek, 1, 14, d.autopilot.approvePerWeek),
      minScore: int(auto.minScore, 0, 100, d.autopilot.minScore),
    },
    weights: weightsOf(r.weights),
    seedTopics: strings(r.seedTopics, 20, 120),
    competitors: [...new Set(strings(r.competitors, 20, 300).flatMap((d) => bareDomain(d) ?? []))].slice(0, 10),
    sources: sourcesOf(r.sources),
    learnWeights: r.learnWeights !== false,
    weightsLearnedMonth: typeof r.weightsLearnedMonth === "string" && MONTH.test(r.weightsLearnedMonth) ? r.weightsLearnedMonth : null,
    weightHistory: history,
  };
}

export async function getIdeaSettings(userId: string, siteId: string): Promise<IdeaSettings> {
  return normalizeIdeaSettings((await getEffectiveSettings(userId, siteId)).ideaSettings);
}

/** The web save: learning's own fields (month, history) and the watched pages' seen links always keep their stored values. */
export async function saveIdeaSettings(userId: string, siteId: string, input: unknown): Promise<IdeaSettings> {
  const stored = await getIdeaSettings(userId, siteId);
  const next = normalizeIdeaSettings(input);
  // Re-normalizing the stored seen links against the submitted pages drops those of removed pages; a changed pattern restarts its baseline.
  const patternOf = (pages: IdeaSources["pages"], url: string) => pages.find((p) => p.url === url)?.pattern;
  const seen = Object.fromEntries(Object.entries(stored.sources.seen).filter(([url]) => patternOf(stored.sources.pages, url) === patternOf(next.sources.pages, url)));
  const sources = sourcesOf({ ...next.sources, seen });
  const ideaSettings = { ...next, sources, weightsLearnedMonth: stored.weightsLearnedMonth, weightHistory: stored.weightHistory };
  await updateSiteSettings(userId, siteId, { ideaSettings });
  return ideaSettings;
}

/** Discovery's own write: only the seen links change, on top of whatever the owner saved meanwhile. */
export async function saveSeenLinks(userId: string, siteId: string, seen: IdeaSources["seen"]): Promise<void> {
  const stored = await getIdeaSettings(userId, siteId);
  await updateSiteSettings(userId, siteId, { ideaSettings: { ...stored, sources: sourcesOf({ ...stored.sources, seen: { ...stored.sources.seen, ...seen } }) } });
}

/** The site's own topics plus the settings' extras, deduped, for discovery. */
// Words scraped from site navigation that make poor search seeds.
const NAV_WORDS = new Set(["home", "about", "about us", "contact", "contacts", "blog", "news", "projects", "services", "pricing", "careers", "team", "privacy", "terms", "faq"]);

/** The owner's seeds first, then editorial topics, then sitemap topics minus brand and navigation words. */
export function effectiveSeedTopics(settings: IdeaSettings, site: { name?: string | null; domain?: string | null; topics?: string[] | null; editorialTopics?: string[] | null }): string[] {
  const brand = new Set([site.name, site.domain, site.domain?.split(".")[0]].filter(Boolean).map((v) => v!.toLowerCase()));
  const scraped = (site.topics ?? []).filter((t) => !NAV_WORDS.has(t.trim().toLowerCase()) && !brand.has(t.trim().toLowerCase()));
  const all = [...settings.seedTopics, ...(site.editorialTopics ?? []), ...scraped].map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  return all.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 12);
}
