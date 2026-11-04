import { z } from "zod";

export const ResearchQueriesSchema = z.object({
  queries: z.array(z.string().min(3).max(200)).min(2).max(8),
});

export const ClaimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string().min(10).max(400),
        kind: z.enum(["statistic", "fact", "definition", "example", "quote"]),
        quote: z.string().min(20).max(800),
      }),
    )
    .max(6),
});
export type ExtractedClaim = z.infer<typeof ClaimExtractionSchema>["claims"][number];

/** Stored as `.output.output`. `claims` maps each claim id (`c1`) to its `article_evidence.id`. */
export const ResearchOutputSchema = z.object({
  queries: z.array(z.string()),
  sourceCount: z.number().int(),
  skippedSources: z.number().int(),
  searchAdapter: z.enum(["searxng", "dataforseo", "none"]).optional(),
  claimCount: z.number().int(),
  verifiedCount: z.number().int(),
  claims: z.array(z.object({ claimId: z.string(), evidenceId: z.string(), verified: z.boolean() })),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
