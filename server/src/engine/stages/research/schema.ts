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

const Competitor = z.object({
  url: z.string(),
  title: z.string().nullable(),
  words: z.number().int(),
  outline: z.array(z.object({ level: z.number().int().min(2).max(3), text: z.string() })),
});
export type Competitor = z.infer<typeof Competitor>;

/** What the model returns about the ranking pages; `typicalLength` is added by code (median competitor words). */
export const SerpAnalysisModelSchema = z.object({
  searchIntent: z.string().min(3).max(200),
  coveredTopics: z.array(z.string().min(2).max(200)).min(1).max(12),
  gaps: z.array(z.string().min(5).max(300)).max(8),
  informationGain: z.array(z.object({ point: z.string().min(10).max(300), claimIds: z.array(z.string()).max(6) })).max(4),
});
export const SerpAnalysisSchema = SerpAnalysisModelSchema.extend({ typicalLength: z.number().int().positive().nullable() });
export type SerpAnalysis = z.infer<typeof SerpAnalysisSchema>;

/** Optional: runs from before the competitor step have none of these. */
export const SerpResearchSchema = z.object({
  competitors: z.array(Competitor).optional(),
  questions: z.array(z.string()).optional(),
  serpAnalysis: SerpAnalysisSchema.nullable().optional(),
});

export type ResearchOutput = z.infer<typeof ResearchOutputSchema> & z.infer<typeof SerpResearchSchema>;
