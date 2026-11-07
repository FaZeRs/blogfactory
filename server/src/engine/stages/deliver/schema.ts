import { z } from "zod";

export const DeliverOutputSchema = z.object({ postId: z.string(), created: z.boolean(), escalated: z.boolean(), refreshed: z.boolean().optional(), note: z.string().nullable().optional() });
export type DeliverOutput = z.infer<typeof DeliverOutputSchema>;
