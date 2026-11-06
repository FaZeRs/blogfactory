import { z } from "zod";
import { PAIN_POINT_IDS, SERVICE_IDS } from "../../components/component-spec.js";
import { ENGINE_CONFIG } from "../../config.js";
import type { ComponentProfile } from "../../profile.js";

const g = ENGINE_CONFIG.gates;
/** The article shape the brief plans: section budgets plus an opening and the FAQ fit this band. */
export const PLAN = {
  openingWords: 250,
  faqWordsEach: 90,
  limits: { min: g.minWords + (g.maxWords - g.targetWords), max: g.targetWords },
  outline: { min: 4, max: 10 },
  faq: { min: 3, max: 6 },
  takeaways: { min: 3, max: 6 },
  /** Lindevo's `key-takeaways` accepts 3-5 list items. */
  lindevoTakeaways: { min: 3, max: 5 },
  links: { min: 0, max: 4 },
} as const;

const OutlineSectionSchema = z.object({
  heading: z.string().min(3).max(90),
  purpose: z.string().min(10).max(300),
  claimIds: z.array(z.string()).max(8),
  words: z.number().int().positive(),
});

export const BriefModelSchema = z.object({
  angle: z.string().min(20).max(400),
  primaryKeyword: z.string().min(3).max(80),
  titleOptions: z.array(z.string().min(5).max(120)).min(3).max(5),
  chosenTitle: z.string().min(5).max(120),
  description: z.string().min(20).max(300),
  outline: z.array(OutlineSectionSchema).min(2).max(14),
  faq: z.array(z.object({ question: z.string().min(10).max(160), answerPoints: z.array(z.string().min(3)).min(1).max(4) })).max(12),
  takeaways: z.array(z.string().min(10).max(200)).min(1).max(8),
  internalLinks: z.array(z.object({ url: z.string(), anchorText: z.string().min(2).max(80) })).max(12),
  /** The call to action's service and pain point, or "none". Required (checked in `validateBrief`) for the Lindevo profile. */
  service: z.enum([...SERVICE_IDS, "none"]).optional(),
  painPoint: z.enum([...PAIN_POINT_IDS, "none"]).optional(),
});
export type Brief = z.infer<typeof BriefModelSchema>;

/** Stored as `.output.output`: the brief plus what code knows about the keyword. */
export const BriefOutputSchema = BriefModelSchema.extend({
  keywordData: z.object({ volume: z.number().nullable(), difficulty: z.number().nullable(), intent: z.string().nullable(), aiOverview: z.boolean() }).nullable(),
});
export type BriefOutput = z.infer<typeof BriefOutputSchema>;

const plannedWords = (b: Pick<Brief, "faq" | "outline">) =>
  PLAN.openingWords + PLAN.faqWordsEach * b.faq.length + b.outline.reduce((sum, s) => sum + s.words, 0);

/** The total word target the plan aims for: the competitors' typical length, kept inside the plan band. */
export const planTarget = (typicalLength: number | null | undefined) =>
  typicalLength ? Math.min(PLAN.limits.max, Math.max(PLAN.limits.min, Math.round(typicalLength / 50) * 50)) : null;

/**
 * Scales section budgets into the allowed band, so a plan that is too long never fails the brief.
 * With a `target` (see `planTarget`) the budgets are scaled to that total instead.
 */
export function fitLengthPlan(b: Brief, target?: number | null): Brief {
  const fixed = PLAN.openingWords + PLAN.faqWordsEach * b.faq.length;
  const sections = plannedWords(b) - fixed;
  const total = fixed + sections;
  if (sections <= 0) return b;
  const goal = target ?? (total > PLAN.limits.max ? PLAN.limits.max : total < PLAN.limits.min ? PLAN.limits.min : null);
  if (goal === null || goal === total) return b;
  const scale = Math.max(0, goal - fixed) / sections;
  const round = goal < total ? Math.floor : Math.ceil;
  return { ...b, outline: b.outline.map((s) => ({ ...s, words: Math.max(1, round(s.words * scale)) })) };
}

/** What code checks and the model cannot be trusted with. The messages join the repair feedback. */
/**
 * Code fixes for near misses a cheap model makes, so a whole brief call is not spent on a few characters: title options
 * over the limit are dropped, a valid chosen title missing from the options is added, a chosen title over the limit is
 * replaced by the first valid option, and a description just over the limit is cut at a word boundary.
 */
export function repairBrief(b: Brief): Brief {
  const fits = (t: string) => t.length <= g.titleMax;
  const options = b.titleOptions.filter(fits);
  const chosenTitle = fits(b.chosenTitle) ? b.chosenTitle : options[0] ?? b.chosenTitle;
  if (fits(chosenTitle) && !options.includes(chosenTitle)) options.unshift(chosenTitle);
  let description = b.description;
  if (description.length > g.descriptionMax && description.length <= g.descriptionMax + 40) {
    const cut = description.slice(0, g.descriptionMax);
    description = cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(g.descriptionMax * 0.7))).replace(/[\s,;:—–-]+$/, "");
  }
  return { ...b, chosenTitle, titleOptions: options.length >= b.titleOptions.length || options.length >= 3 ? options : b.titleOptions, description };
}

export function validateBrief(b: Brief, ctx: { verifiedIds: Set<string>; links: Set<string>; minClaims: number; profile?: ComponentProfile }): string[] {
  const issues: string[] = [];
  const range = (name: string, n: number, r: { min: number; max: number }) => {
    if (n < r.min || n > r.max) issues.push(`${name}: ${n} given, ${r.min}-${r.max} allowed`);
  };
  range("outline sections", b.outline.length, PLAN.outline);
  range("FAQ questions", b.faq.length, PLAN.faq);
  const lindevo = ctx.profile === "lindevo";
  range("takeaways", b.takeaways.length, lindevo ? PLAN.lindevoTakeaways : PLAN.takeaways);
  if (lindevo) {
    if (!b.service) issues.push(`service is required: one of ${SERVICE_IDS.join(", ")} or "none"`);
    if (!b.painPoint) issues.push(`painPoint is required: one of ${PAIN_POINT_IDS.join(", ")} or "none"`);
  }
  range("internal links", b.internalLinks.length, PLAN.links);
  if (!b.titleOptions.includes(b.chosenTitle)) issues.push("chosenTitle must be one of titleOptions");
  for (const [name, t] of [["chosenTitle", b.chosenTitle], ...b.titleOptions.map((t, i) => [`titleOptions[${i}]`, t] as const)] as const) {
    if (t.length > g.titleMax) issues.push(`${name} is ${t.length} characters, at most ${g.titleMax} allowed`);
  }
  if (b.description.length > g.descriptionMax) issues.push(`description is ${b.description.length} characters, at most ${g.descriptionMax} allowed`);
  const used = new Set<string>();
  b.outline.forEach((s, i) => {
    for (const id of s.claimIds) {
      if (ctx.verifiedIds.has(id)) used.add(id);
      else issues.push(`outline[${i}] cites unknown or unverified claim "${id.slice(0, 40)}"`);
    }
  });
  if (used.size < ctx.minClaims) issues.push(`the outline cites ${used.size} verified claims; cite at least ${ctx.minClaims} different ones`);
  b.internalLinks.forEach((l, i) => {
    if (!ctx.links.has(l.url)) issues.push(`internalLinks[${i}] "${l.url.slice(0, 80)}" is not in the candidate list`);
  });
  b.faq.forEach((f, i) => {
    if (!f.question.trim().endsWith("?")) issues.push(`faq[${i}] question must end with "?"`);
  });
  return issues;
}
