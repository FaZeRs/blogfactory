import { z } from "zod";

/** A fix is a local edit: at most twice the quote plus a few words, never a whole new passage. */
export const MAX_GROWTH = 2;
export const GROWTH_SLACK = 20;

const EXCERPT_MAX = 300;
/** As long as `patchTranslation` applies: a fix may grow its excerpt, so it is not held to the excerpt's cap. */
const FIX_MAX = EXCERPT_MAX * MAX_GROWTH + GROWTH_SLACK;

/** The model may write the slug with diacritics; the code turns it into ASCII and checks it. */
export const TranslationSchema = z.object({
  title: z.string().min(3).max(200),
  slug: z.string().min(1).max(160),
  description: z.string().max(500),
  markdown: z.string().min(1),
  imageAlt: z.string().max(300),
});

export type Translated = { title: string; slug: string; description: string; markdown: string; imageAlt: string };
/** The fields a review fix may name. */
export type FixField = "markdown" | "title" | "description";

export const ReviewSchema = z.object({
  fluency: z.number().int().min(0).max(10),
  issues: z.array(z.object({
    excerpt: z.string().max(EXCERPT_MAX),
    field: z.enum(["markdown", "title", "description"]).optional(),
    fix: z.string().max(FIX_MAX),
    problem: z.string().max(EXCERPT_MAX),
    severity: z.enum(["major", "minor"]),
  })).max(20),
});
export type Review = z.infer<typeof ReviewSchema>;

export const KeywordCandidatesSchema = z.object({
  candidates: z.array(z.string().min(2).max(80)).min(1).max(5),
});
