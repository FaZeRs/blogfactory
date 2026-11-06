import { z } from "zod";
import { GatesOutputSchema } from "../gates/schema.js";

export const FACTCHECK_KINDS = ["unsupported", "overstated", "uncited_fact", "contradiction"] as const;
export const READER_KINDS = ["unclear", "missing_step", "unanswered_question", "padding", "jargon"] as const;
/** The gate ids the review stage writes to `article_gate_results`. */
export const REVIEW_GATES = ["factcheck", "reader"] as const;

/** What the models return; the stage caps the counts and excerpt lengths itself. */
export const FactcheckSchema = z.object({
  issues: z.array(z.object({ kind: z.enum(FACTCHECK_KINDS), excerpt: z.string(), claimId: z.string().optional(), fix: z.string() })),
});
export const ReaderSchema = z.object({
  issues: z.array(z.object({ kind: z.enum(READER_KINDS), excerpt: z.string(), fix: z.string() })),
});

/** Stored as `.output.output`: the gates shape (revise reads `blockers` from either) plus the hallucinated excerpts dropped. */
export const ReviewOutputSchema = GatesOutputSchema.extend({ dropped: z.number().int() });
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
