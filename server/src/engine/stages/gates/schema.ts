import { z } from "zod";

/** Stored as `.output.output`. The blockers feed the revise prompt; `reason` is set when the run stops short. */
export const GatesOutputSchema = z.object({
  passed: z.boolean(),
  blockerCount: z.number().int(),
  warningCount: z.number().int(),
  blockers: z.array(z.object({ gate: z.string(), message: z.string(), excerpt: z.string().optional(), fix: z.string().optional() })),
  escalated: z.boolean(),
  reason: z.string().nullable(),
});
export type GatesOutput = z.infer<typeof GatesOutputSchema>;
