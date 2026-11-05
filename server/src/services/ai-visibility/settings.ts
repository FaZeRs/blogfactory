import { bareDomain } from "../ideas/settings.js";
import { getEffectiveSettings, getSiteForUser, updateSiteSettings } from "../user-settings.js";

export const DEFAULT_ENGINES = ["openai/gpt-5.6-luna", "perplexity/sonar", "google/gemini-3.5-flash"];
export const MAX_ENGINES = 5;
export const MAX_QUESTIONS = 30;
export const ENGINE_ID = /^[a-z0-9-]+\/[a-z0-9.:_-]+$/;

export const ENGINE_LABELS: Record<string, string> = {
  openai: "OpenAI", perplexity: "Perplexity", google: "Google", anthropic: "Claude", "x-ai": "Grok",
};

/** "openai/gpt-5.6-luna" becomes "OpenAI"; an unknown provider prefix is its own label. */
export const engineLabel = (model: string) => {
  const prefix = model.split("/")[0] ?? model;
  return ENGINE_LABELS[prefix] ?? prefix;
};

export type VisibilitySettings = {
  enabled: boolean;
  questions: string[];
  engines: string[];
  /** JS numbering: 0 Sunday ... 6 Saturday. */
  weekday: number;
  monthlyCapUsd: number;
  brandTerms: string[];
};

type SiteIdentity = { name?: string | null; domain?: string | null };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strings = (v: unknown, max: number, len: number) =>
  Array.isArray(v) ? [...new Set(v.flatMap((x) => typeof x === "string" && x.trim() ? [x.trim().slice(0, len)] : []))].slice(0, max) : [];

export function defaultBrandTerms(site: SiteIdentity): string[] {
  const domain = bareDomain(site.domain) ?? site.domain?.trim().toLowerCase() ?? "";
  const terms = [site.name?.trim(), domain, domain.replace(/\.[^.]+$/, "")].filter((t): t is string => !!t);
  return [...new Set(terms)];
}

/** Any stored or submitted value in, a complete valid settings object out. Never throws. */
export function normalizeVisibilitySettings(raw: unknown, site: SiteIdentity): VisibilitySettings {
  const r = obj(raw);
  const engines = strings(r.engines, 50, 120).filter((e) => ENGINE_ID.test(e)).slice(0, MAX_ENGINES);
  const brandTerms = strings(r.brandTerms, 10, 80);
  const weekday = typeof r.weekday === "number" && Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 ? r.weekday : 1;
  const cap = typeof r.monthlyCapUsd === "number" && Number.isFinite(r.monthlyCapUsd) ? Math.min(1000, Math.max(0, r.monthlyCapUsd)) : 15;
  return {
    enabled: r.enabled === true,
    questions: strings(r.questions, MAX_QUESTIONS, 200),
    engines: engines.length ? engines : [...DEFAULT_ENGINES],
    weekday,
    monthlyCapUsd: cap,
    brandTerms: brandTerms.length ? brandTerms : defaultBrandTerms(site),
  };
}

export async function getVisibilitySettings(userId: string, siteId: string): Promise<VisibilitySettings> {
  const site = await getSiteForUser(userId, siteId);
  if (!site) throw new Error("Site not found");
  return normalizeVisibilitySettings((await getEffectiveSettings(userId, siteId)).aiVisibility, site);
}

/** Normalizes, then saves. Question rules are checked by the caller with `validateQuestions`. */
export async function saveVisibilitySettings(userId: string, siteId: string, input: unknown): Promise<VisibilitySettings> {
  const site = await getSiteForUser(userId, siteId);
  if (!site) throw new Error("Site not found");
  const aiVisibility = normalizeVisibilitySettings(input, site);
  await updateSiteSettings(userId, siteId, { aiVisibility });
  return aiVisibility;
}
