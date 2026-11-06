import { ApiError } from "../http/error-contract.js";
import { getUserId } from "../middleware/auth.js";
import { getSiteForUser } from "../services/user-settings.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The web shows the top-level message, so it carries the guidance rather than "Invalid <field>".
export const validation = (field: string, message: string) => new ApiError(400, "validation_error", message, [{ field, message }]);

/** The signed-in user's site by id: 400 for a malformed id, 404 for another user's site. */
export async function ownedSite(c: Parameters<typeof getUserId>[0], source: string | undefined | null) {
  const userId = getUserId(c);
  if (!source || !UUID.test(source)) throw validation("siteId", "A site id is required");
  const site = await getSiteForUser(userId, source);
  if (!site) throw new ApiError(404, "not_found", "Site not found");
  return { userId, siteId: site.id, site };
}
