import { getEffectiveSettings, updateSiteSettings } from "../user-settings.js";

export type GlossaryEntry = { source: string; target: string; note?: string };
export type LocaleSetting = {
  /** `lv`, `de`, `pt-BR`. */
  locale: string;
  name: string;
  glossary: GlossaryEntry[];
  /** The target language's house style, written by the owner. */
  styleGuide: string;
  /** Informal forms that must not appear (for Latvian: tu, tev...). */
  formalAddress?: { forbidden: string[] };
};
export type LocalizationSettings = { enabled: boolean; locales: LocaleSetting[] };

export const DEFAULT_LOCALIZATION: LocalizationSettings = { enabled: false, locales: [] };

export const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
export const LIMITS = { locales: 3, name: 40, glossary: 200, term: 120, note: 200, styleGuide: 20_000, forbidden: 40, forbiddenWord: 40 } as const;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Any stored or submitted value in, a complete valid settings object out. Never throws. */
export function normalizeLocalization(raw: unknown): LocalizationSettings {
  const r = obj(raw);
  const seen = new Set<string>();
  const locales: LocaleSetting[] = [];
  for (const item of Array.isArray(r.locales) ? r.locales : []) {
    const l = obj(item);
    const locale = typeof l.locale === "string" ? l.locale.trim() : "";
    if (!LOCALE_RE.test(locale) || seen.has(locale) || locales.length >= LIMITS.locales) continue;
    seen.add(locale);
    const glossary: GlossaryEntry[] = [];
    for (const g of Array.isArray(l.glossary) ? l.glossary : []) {
      const e = obj(g);
      const source = text(e.source, LIMITS.term);
      const target = text(e.target, LIMITS.term);
      if (!source || !target || glossary.length >= LIMITS.glossary) continue;
      const note = text(e.note, LIMITS.note);
      glossary.push(note ? { source, target, note } : { source, target });
    }
    const rawForbidden = obj(l.formalAddress).forbidden;
    const forbidden = [...new Set((Array.isArray(rawForbidden) ? rawForbidden : []).flatMap((w) => (text(w, LIMITS.forbiddenWord) ? [text(w, LIMITS.forbiddenWord)] : [])))].slice(0, LIMITS.forbidden);
    locales.push({
      locale,
      name: text(l.name, LIMITS.name) || locale,
      glossary,
      styleGuide: typeof l.styleGuide === "string" ? l.styleGuide.trim().slice(0, LIMITS.styleGuide) : "",
      ...(forbidden.length ? { formalAddress: { forbidden } } : {}),
    });
  }
  return { enabled: r.enabled === true, locales };
}

export async function getLocalization(userId: string, siteId: string): Promise<LocalizationSettings> {
  return normalizeLocalization((await getEffectiveSettings(userId, siteId)).localization);
}

export async function saveLocalization(userId: string, siteId: string, input: unknown): Promise<LocalizationSettings> {
  const localization = normalizeLocalization(input);
  await updateSiteSettings(userId, siteId, { localization });
  return localization;
}

/** The locales a new article is translated into: none unless the site turned localization on. */
export const activeLocales = (s: LocalizationSettings): LocaleSetting[] => (s.enabled ? s.locales : []);
