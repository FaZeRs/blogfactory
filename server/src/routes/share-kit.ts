import { Hono } from "hono";
import { getUserId } from "../middleware/auth.js";
import { createShareKit, getShareKit, type ShareKitDeps } from "../services/share-kit.js";

/** The model deps are injectable so self-tests never call a provider. */
export function createShareKitRoutes(deps: { shareKitDeps?: ShareKitDeps } = {}) {
  return new Hono()
    .get("/:id/share-kit", async (c) => c.json({ share_kit: await getShareKit(getUserId(c), c.req.param("id")) }))
    .post("/:id/share-kit", async (c) =>
      c.json({ share_kit: await createShareKit({ userId: getUserId(c), postId: c.req.param("id"), deps: deps.shareKitDeps, signal: c.req.raw.signal }) }));
}
