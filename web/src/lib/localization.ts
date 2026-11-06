import type { StatusType } from "@/components/ui/status-badge";

export type GlossaryEntry = { source: string; target: string; note?: string };
export type LocaleSetting = {
  locale: string;
  name: string;
  glossary: GlossaryEntry[];
  styleGuide: string;
  formalAddress?: { forbidden: string[] };
};
export type LocalizationSettings = { enabled: boolean; locales: LocaleSetting[] };

export type TranslationStatus = "ready" | "needs_review" | "edited" | "running";
export type TranslationFinding = { gate: string; severity: "blocker" | "warning"; message: string; excerpt?: string; hint?: string };
export type PostTranslation = {
  locale: string;
  status: TranslationStatus;
  stale: boolean;
  title: string;
  slug: string;
  description: string;
  content: string;
  imageAlt: string;
  keyword: string | null;
  findings: TranslationFinding[];
  updatedAt: string;
};

/** Mirrors the server limits in services/localization/settings.ts. */
export const LOCALIZATION_LIMITS = { locales: 3, glossary: 200 } as const;
export const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export const localizationKey = (siteId: string | null | undefined) => ["localization", siteId] as const;
export const translationsKey = (postId: string) => ["post-translations", postId] as const;

export const ENGLISH = "en";

/** The badges a translation shows: its status, plus Stale when the English moved on. */
export function translationBadges(t: PostTranslation): Array<{ status: StatusType; label: string }> {
  const badges: Array<{ status: StatusType; label: string }> = [];
  if (t.status === "running") badges.push({ status: "running", label: "Translating" });
  else if (t.status === "ready") badges.push({ status: "success", label: "Ready" });
  else if (t.status === "edited") badges.push({ status: "active", label: "Edited" });
  else badges.push({ status: "warning", label: "Needs review" });
  if (t.stale) badges.push({ status: "warning", label: "Stale" });
  return badges;
}
