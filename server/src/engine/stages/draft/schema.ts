import { z } from "zod";

/** What the model returns: the article body with `{{c:id}}` markers, no front matter. */
export const DraftSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(20).max(300),
  markdown: z.string().min(2000),
  citedClaimIds: z.array(z.string()).max(40),
});
export type Draft = z.infer<typeof DraftSchema>;

/** Stored as `.output.output`. `markdown` is the raw draft with its `{{c:id}}` markers. */
export const DraftOutputSchema = z.object({
  title: z.string(),
  description: z.string(),
  markdown: z.string(),
  citedClaimIds: z.array(z.string()),
  unresolvedMarkers: z.array(z.string()),
  words: z.number().int(),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;
