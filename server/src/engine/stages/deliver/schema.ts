import { z } from "zod";

export const DeliverOutputSchema = z.object({ postId: z.string(), created: z.boolean(), escalated: z.boolean() });
export type DeliverOutput = z.infer<typeof DeliverOutputSchema>;
