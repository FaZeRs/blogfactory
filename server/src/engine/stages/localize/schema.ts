import { z } from "zod";

export const LocalizedLocaleSchema = z.object({
  locale: z.string(),
  /** `failed`: no translation exists for this locale; nothing is stored. */
  status: z.enum(["ready", "needs_review", "failed"]),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  content: z.string(),
  imageAlt: z.string(),
  keyword: z.string().nullable(),
  findings: z.array(z.object({
    gate: z.string(), severity: z.enum(["blocker", "warning"]), message: z.string(), excerpt: z.string().optional(), hint: z.string().optional(),
  })),
  costUsd: z.number(),
  error: z.string().optional(),
});
export type LocalizedLocale = z.infer<typeof LocalizedLocaleSchema>;

/** Stored as `.output.output`: one entry per locale. Deliver writes the `post_translations` rows from it. */
export const LocalizeOutputSchema = z.object({ locales: z.array(LocalizedLocaleSchema) });
export type LocalizeOutput = z.infer<typeof LocalizeOutputSchema>;
