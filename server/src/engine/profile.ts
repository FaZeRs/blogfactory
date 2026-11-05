import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { siteIntegrations } from "../db/schema.js";

export type ComponentProfile = "lindevo" | "markdown";

/**
 * The provider a run's draft is meant for, frozen into the run settings at start: the preferred
 * integration's provider, else the site's only connected destination, else null.
 */
export async function resolveDestinationProvider(userId: string, siteId: string, preferredIntegrationId?: string | null): Promise<string | null> {
  const rows = await db.select({ id: siteIntegrations.id, provider: siteIntegrations.provider }).from(siteIntegrations)
    .where(and(eq(siteIntegrations.userId, userId), eq(siteIntegrations.siteId, siteId), eq(siteIntegrations.status, "connected")));
  if (preferredIntegrationId) return rows.find((r) => r.id === preferredIntegrationId)?.provider ?? null;
  return rows.length === 1 ? rows[0]!.provider : null;
}

/** Lindevo's markdown components only when the frozen destination is Lindevo; every other CMS gets plain Markdown. */
export const componentProfile = (run: { settings: unknown }): ComponentProfile =>
  (run.settings as { destinationProvider?: unknown } | null)?.destinationProvider === "lindevo" ? "lindevo" : "markdown";
