import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { db, type Database } from "../db/index.js";
import { imageAssets, imageGenerationRequests, posts } from "../db/schema.js";
import { eq, and, inArray, desc, or, lt, ne, gte, ilike, sql, type SQL } from "drizzle-orm";
import { getUserId } from "../middleware/auth.js";
import { deleteFile, imageAssetValues, storeImageBuffer } from "../services/image-storage.js";
import { attachImageRequestToPost, drainDeferredImages, kickDeferredImageWorker } from "../services/low-cost-images.js";
import { attachPostImage } from "../services/image-post-attachments.js";
import { queueDeferredImageRequest } from "../services/ai-image-queue.js";
import { buildImageAltText } from "../services/image-slots.js";
import { COVER_PRESETS, adjustCoverPrompt, cleanCoverPrompt, coverPromptDraft, isCoverPresetId } from "../services/cover-tools.js";
import { getOpenRouterModels, imageModelCanEdit } from "../services/openrouter-models.js";
import { getOpenRouterKey } from "../services/api-keys.js";
import { getEffectiveSettings } from "../services/user-settings.js";
import { canRestartImageRequest } from "./image-request-controls.js";
import { createManualImagePromptRequestsForPost } from "../services/generate-content.js";
import { removeInlineImagePath } from "../services/image-placement.js";
import { partitionSettled } from "../services/atomic-state.js";
import { parseImageGalleryQuery } from "./image-gallery-query.js";
import { readJsonObject, requiredEnum, requiredStringArray } from "../http/error-contract.js";

export const imagesRoutes = new Hono();

type ImageMutationDatabase = Pick<Database, "select" | "update">;

async function detachDeletedAsset(executor: ImageMutationDatabase, asset: typeof imageAssets.$inferSelect, userId: string) {
  if (!asset.postId) return;
  const [post] = await executor.select({
    coverImageUrl: posts.coverImageUrl,
    inlineImages: posts.inlineImages,
    content: posts.content,
  }).from(posts).where(and(eq(posts.id, asset.postId), eq(posts.userId, userId))).limit(1);
  if (!post) return;

  const changes: Partial<typeof posts.$inferInsert> = {};
  if (post.coverImageUrl === asset.storagePath) changes.coverImageUrl = null;
  if ((post.inlineImages || []).includes(asset.storagePath)) {
    changes.inlineImages = (post.inlineImages || []).filter((path) => path !== asset.storagePath);
  }
  if ((post.content || "").includes(asset.storagePath)) {
    changes.content = removeInlineImagePath(post.content || "", asset.storagePath);
  }
  if (Object.keys(changes).length) {
    await executor.update(posts).set(changes).where(and(eq(posts.id, asset.postId), eq(posts.userId, userId)));
  }
}

function serializeAsset(row: any) {
  return {
    ...row,
    storage_path: row.storagePath,
    alt_text: row.altText,
    model_id: row.modelId,
    aspect_ratio: row.aspectRatio,
    file_size_bytes: row.fileSizeBytes,
    source_url: row.sourceUrl,
    license_label: row.licenseLabel,
    attribution_url: row.attributionUrl,
    source_kind: row.sourceKind,
    job_id: row.jobId,
    post_id: row.postId,
    created_at: row.createdAt,
    post_title: row.postTitle,
    post_status: row.postStatus,
  };
}

function serializeRequest(row: any) {
  return {
    ...row,
    post_id: row.postId,
    job_id: row.jobId,
    alt_text: row.altText,
    aspect_ratio: row.aspectRatio,
    model_id: row.modelId,
    retry_count: row.retryCount,
    available_at: row.availableAt,
    source_url: row.sourceUrl,
    license_label: row.licenseLabel,
    attribution_url: row.attributionUrl,
    imported_asset_id: row.importedAssetId,
    last_error: row.lastError,
    completed_via: row.completedVia,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    post_title: row.postTitle,
  };
}

imagesRoutes.get("/", async (c) => {
  const userId = getUserId(c);
  const query = parseImageGalleryQuery(c.req.query());
  const conditions: SQL[] = [eq(imageAssets.userId, userId)];
  if (query.type) conditions.push(eq(imageAssets.type, query.type));
  if (query.status) conditions.push(eq(imageAssets.status, query.status));
  if (query.postStatus) conditions.push(eq(posts.status, query.postStatus));
  if (query.aspectRatio) conditions.push(eq(imageAssets.aspectRatio, query.aspectRatio));
  if (query.createdAfter) conditions.push(gte(imageAssets.createdAt, query.createdAfter));
  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(or(
      ilike(posts.title, pattern),
      ilike(imageAssets.prompt, pattern),
      ilike(imageAssets.modelId, pattern),
    )!);
  }

  const listQuery = db
    .select({
      id: imageAssets.id,
      storagePath: imageAssets.storagePath,
      type: imageAssets.type,
      status: imageAssets.status,
      prompt: imageAssets.prompt,
      altText: imageAssets.altText,
      modelId: imageAssets.modelId,
      provider: imageAssets.provider,
      aspectRatio: imageAssets.aspectRatio,
      resolution: imageAssets.resolution,
      position: imageAssets.position,
      cost: imageAssets.cost,
      fileSizeBytes: imageAssets.fileSizeBytes,
      sourceUrl: imageAssets.sourceUrl,
      credit: imageAssets.credit,
      licenseLabel: imageAssets.licenseLabel,
      attributionUrl: imageAssets.attributionUrl,
      sourceKind: imageAssets.sourceKind,
      jobId: imageAssets.jobId,
      postId: imageAssets.postId,
      createdAt: imageAssets.createdAt,
      postTitle: posts.title,
      postStatus: posts.status,
    })
    .from(imageAssets)
    .leftJoin(posts, eq(imageAssets.postId, posts.id))
    .where(and(...conditions));

  const [rows, [filtered], [stats]] = await Promise.all([
    listQuery.orderBy(desc(imageAssets.createdAt), desc(imageAssets.id)).limit(query.limit).offset((query.page - 1) * query.limit),
    db.select({ total: sql<number>`count(*)::int` }).from(imageAssets).leftJoin(posts, eq(imageAssets.postId, posts.id)).where(and(...conditions)),
    db.select({
      total: sql<number>`count(*)::int`,
      cover: sql<number>`count(*) filter (where ${imageAssets.type} = 'cover')::int`,
      inline: sql<number>`count(*) filter (where ${imageAssets.type} = 'inline')::int`,
      orphaned: sql<number>`count(*) filter (where ${imageAssets.status} = 'orphaned')::int`,
      unused: sql<number>`count(*) filter (where ${imageAssets.status} = 'unused')::int`,
      totalCost: sql<number>`coalesce(sum(${imageAssets.cost}), 0)::float8`,
    }).from(imageAssets).where(eq(imageAssets.userId, userId)),
  ]);

  const total = Number(filtered?.total || 0);
  return c.json({
    items: rows.map(serializeAsset),
    stats: {
      total: Number(stats?.total || 0),
      cover: Number(stats?.cover || 0),
      inline: Number(stats?.inline || 0),
      orphaned: Number(stats?.orphaned || 0),
      unused: Number(stats?.unused || 0),
      totalCost: Number(stats?.totalCost || 0),
    },
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.max(1, Math.ceil(total / query.limit)),
    },
  });
});

imagesRoutes.get("/requests", async (c) => {
  const userId = getUserId(c);
  const status = c.req.query("status");
  const conditions = [eq(imageGenerationRequests.userId, userId)];
  if (status === "active") {
    conditions.push(inArray(imageGenerationRequests.status, ["pending", "queued", "processing"]));
  } else if (status === "all") {
    conditions.push(inArray(imageGenerationRequests.status, ["pending", "queued", "processing", "failed", "done"]));
  } else if (status) {
    conditions.push(eq(imageGenerationRequests.status, status));
  }

  const rows = await db
    .select({
      id: imageGenerationRequests.id,
      postId: imageGenerationRequests.postId,
      jobId: imageGenerationRequests.jobId,
      provider: imageGenerationRequests.provider,
      prompt: imageGenerationRequests.prompt,
      altText: imageGenerationRequests.altText,
      modelId: imageGenerationRequests.modelId,
      type: imageGenerationRequests.type,
      position: imageGenerationRequests.position,
      aspectRatio: imageGenerationRequests.aspectRatio,
      resolution: imageGenerationRequests.resolution,
      status: imageGenerationRequests.status,
      retryCount: imageGenerationRequests.retryCount,
      availableAt: imageGenerationRequests.availableAt,
      sourceUrl: imageGenerationRequests.sourceUrl,
      credit: imageGenerationRequests.credit,
      licenseLabel: imageGenerationRequests.licenseLabel,
      attributionUrl: imageGenerationRequests.attributionUrl,
      importedAssetId: imageGenerationRequests.importedAssetId,
      lastError: imageGenerationRequests.lastError,
      completedVia: imageGenerationRequests.completedVia,
      createdAt: imageGenerationRequests.createdAt,
      updatedAt: imageGenerationRequests.updatedAt,
      postTitle: posts.title,
    })
    .from(imageGenerationRequests)
    .leftJoin(posts, eq(imageGenerationRequests.postId, posts.id))
    .where(and(...conditions))
    .orderBy(desc(imageGenerationRequests.createdAt));

  if ((status === "active" || status === "all") && rows.some((row) => row.provider === "ai-deferred" && row.status === "queued")) {
    waitUntil(kickDeferredImageWorker(userId));
  }

  return c.json(rows.map(serializeRequest));
});

imagesRoutes.post("/queue/process", async (c) => {
  const userId = getUserId(c);
  const results = await drainDeferredImages(userId);
  return c.json({
    processed: results.some((result) => result.processed),
    results,
    ...results.find((result) => result.processed),
    error: results.find((result) => result.error)?.error,
  });
});

imagesRoutes.post("/posts/:postId/manual-prompts", async (c) => {
  const userId = getUserId(c);
  const postId = c.req.param("postId");

  try {
    const result = await createManualImagePromptRequestsForPost(userId, postId);
    return c.json(result, result.created > 0 ? 201 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create image prompts";
    const status = message === "Post not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

type CoverPost = { id: string; title: string; content: string | null; siteId: string | null; jobId: string | null; coverImageUrl: string | null };

async function loadCoverPost(postId: string, userId: string): Promise<CoverPost | undefined> {
  const [post] = await db.select({ id: posts.id, title: posts.title, content: posts.content, siteId: posts.siteId, jobId: posts.jobId, coverImageUrl: posts.coverImageUrl })
    .from(posts).where(and(eq(posts.id, postId), eq(posts.userId, userId))).limit(1);
  return post;
}

function coverResolution(settings: { imageAdvancedOptions?: unknown }) {
  const options = settings.imageAdvancedOptions as Record<string, unknown> | null | undefined;
  return options && options.coverResolution === "512" ? "512" : "1K";
}

async function coverImageCost(userId: string, modelId: string, resolution: string) {
  try {
    const apiKey = await getOpenRouterKey(userId);
    if (!apiKey) return null;
    const model = (await getOpenRouterModels(apiKey, "image")).find((m: { id: string }) => m.id === modelId);
    const price = model?.rawPricing.imageByResolution[resolution as "512" | "1K"] || model?.rawPricing.image;
    return price || null;
  } catch {
    return null;
  }
}

const coverUrl = (path: string) => `/api/storage/${path}`;

imagesRoutes.get("/posts/:postId/covers", async (c) => {
  const userId = getUserId(c);
  const post = await loadCoverPost(c.req.param("postId"), userId);
  if (!post) return c.json({ error: "Post not found" }, 404);
  const settings = await getEffectiveSettings(userId, post.siteId);
  const [versions, pending] = await Promise.all([
    db.select().from(imageAssets)
      .where(and(eq(imageAssets.userId, userId), eq(imageAssets.postId, post.id), eq(imageAssets.type, "cover")))
      .orderBy(desc(imageAssets.createdAt), desc(imageAssets.id)),
    db.select({ id: imageGenerationRequests.id, status: imageGenerationRequests.status, referencePath: imageGenerationRequests.referencePath })
      .from(imageGenerationRequests)
      .where(and(
        eq(imageGenerationRequests.userId, userId),
        eq(imageGenerationRequests.postId, post.id),
        eq(imageGenerationRequests.type, "cover"),
        inArray(imageGenerationRequests.status, ["queued", "processing"]),
      ))
      .orderBy(desc(imageGenerationRequests.createdAt)),
  ]);
  const apiKey = settings.imageModel ? await getOpenRouterKey(userId) : null;
  const defaultPreset = "site_default";
  return c.json({
    cover: post.coverImageUrl ? { path: post.coverImageUrl, url: coverUrl(post.coverImageUrl) } : null,
    versions: versions.map((v) => ({
      id: v.id,
      path: v.storagePath,
      url: coverUrl(v.storagePath),
      source_kind: v.sourceKind,
      prompt: v.prompt,
      model_id: v.modelId,
      created_at: v.createdAt,
    })),
    pending: pending.map((r) => ({ id: r.id, status: r.status, kind: r.referencePath ? "adjust" : "generate" })),
    presets: COVER_PRESETS.map(({ id, label }) => ({ id, label })),
    default_preset: defaultPreset,
    prompt_draft: coverPromptDraft({ title: post.title, content: post.content || "", preset: defaultPreset, settings }),
    prompt_drafts: Object.fromEntries(COVER_PRESETS.map((p) => [p.id, coverPromptDraft({ title: post.title, content: post.content || "", preset: p.id, settings })])),
    image_model: settings.imageModel || null,
    can_edit: Boolean(apiKey && settings.imageModel && await imageModelCanEdit(apiKey, settings.imageModel)),
    cost_per_image: settings.imageModel ? await coverImageCost(userId, settings.imageModel, coverResolution(settings)) : null,
  });
});

/**
 * Queues AI covers for an existing post. Rendering takes 10-30s, longer than proxies and Bun's idle timeout allow,
 * so this returns at once; the image worker stores each result as a version and the editor polls /covers.
 */
imagesRoutes.post("/posts/:postId/cover", async (c) => {
  const userId = getUserId(c);
  const post = await loadCoverPost(c.req.param("postId"), userId);
  if (!post) return c.json({ error: "Post not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const count = body.count === undefined ? 1 : body.count;
  if (count !== 1 && count !== 3) return c.json({ error: "count must be 1 or 3", code: "invalid_count" }, 400);
  if (body.preset !== undefined && !isCoverPresetId(body.preset)) return c.json({ error: "Unknown cover style", code: "invalid_preset" }, 400);
  const settings = await getEffectiveSettings(userId, post.siteId);
  if (!settings.imageModel) return c.json({ error: "Choose an image model in Article Settings first.", code: "image_model_missing" }, 400);
  let prompt: string;
  if (body.prompt !== undefined) {
    const cleaned = cleanCoverPrompt(body.prompt);
    if (!cleaned) return c.json({ error: "Prompt must be at least 10 characters.", code: "invalid_prompt" }, 400);
    prompt = cleaned;
  } else {
    prompt = coverPromptDraft({ title: post.title, content: post.content || "", preset: (body.preset as string | undefined) ?? "site_default", settings });
  }
  const slot = { type: "cover" as const, position: 0, aspectRatio: "16:9", resolution: coverResolution(settings), prompt, altText: buildImageAltText({ title: post.title, type: "cover", content: post.content || "" }) };
  const requestIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const queued = await queueDeferredImageRequest({ userId, postId: post.id, jobId: post.jobId, imageModel: settings.imageModel, slot, force: true, replacesCover: post.coverImageUrl ?? null });
    if (queued.id) requestIds.push(queued.id);
  }
  await kickDeferredImageWorker(userId);
  return c.json({ request_ids: requestIds }, 202);
});

imagesRoutes.post("/posts/:postId/cover/adjust", async (c) => {
  const userId = getUserId(c);
  const post = await loadCoverPost(c.req.param("postId"), userId);
  if (!post) return c.json({ error: "Post not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const instruction = typeof body.instruction === "string" ? body.instruction.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim() : "";
  if (instruction.length < 3 || instruction.length > 500) return c.json({ error: "Instruction must be 3 to 500 characters.", code: "invalid_instruction" }, 400);
  if (!post.coverImageUrl) return c.json({ error: "This post has no cover to adjust.", code: "cover_missing" }, 400);
  const settings = await getEffectiveSettings(userId, post.siteId);
  if (!settings.imageModel) return c.json({ error: "Choose an image model in Article Settings first.", code: "image_model_missing" }, 400);
  const apiKey = await getOpenRouterKey(userId);
  if (!apiKey || !(await imageModelCanEdit(apiKey, settings.imageModel))) {
    return c.json({ error: "This image model cannot edit images. Choose another in Article Settings.", code: "image_edit_unsupported" }, 400);
  }
  const slot = { type: "cover" as const, position: 0, aspectRatio: "16:9", resolution: coverResolution(settings), prompt: adjustCoverPrompt(instruction), altText: buildImageAltText({ title: post.title, type: "cover", content: post.content || "" }) };
  const queued = await queueDeferredImageRequest({ userId, postId: post.id, jobId: post.jobId, imageModel: settings.imageModel, slot, force: true, referencePath: post.coverImageUrl, replacesCover: post.coverImageUrl });
  await kickDeferredImageWorker(userId);
  return c.json({ request_ids: queued.id ? [queued.id] : [] }, 202);
});

imagesRoutes.put("/posts/:postId/cover", async (c) => {
  const userId = getUserId(c);
  const post = await loadCoverPost(c.req.param("postId"), userId);
  if (!post) return c.json({ error: "Post not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const assetId = typeof body.asset_id === "string" ? body.asset_id : "";
  const [asset] = assetId && /^[0-9a-f-]{36}$/i.test(assetId)
    ? await db.select().from(imageAssets).where(and(eq(imageAssets.id, assetId), eq(imageAssets.userId, userId), eq(imageAssets.postId, post.id), eq(imageAssets.type, "cover"))).limit(1)
    : [];
  if (!asset) return c.json({ error: "Cover version not found" }, 404);
  await attachPostImage(post.id, { type: "cover", position: 0, aspectRatio: "16:9", resolution: asset.resolution || "1K", prompt: asset.prompt || "", altText: asset.altText || "" }, asset.storagePath, "auto", userId);
  return c.json({ cover_image_url: asset.storagePath });
});

imagesRoutes.post("/requests/:id/retry", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");

  const [request] = await db
    .select()
    .from(imageGenerationRequests)
    .where(and(eq(imageGenerationRequests.id, id), eq(imageGenerationRequests.userId, userId)))
    .limit(1);

  if (!request) return c.json({ error: "Image request not found" }, 404);
  if (!canRestartImageRequest(request.provider, request.status)) {
    return c.json({ error: "Only active or failed AI image requests can be restarted" }, 400);
  }

  const [updated] = await db
    .update(imageGenerationRequests)
    .set({
      status: "queued",
      retryCount: request.status === "processing" ? (request.retryCount || 0) + 1 : 0,
      lastError: null,
      completedVia: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(imageGenerationRequests.id, id), eq(imageGenerationRequests.userId, userId)))
    .returning();

  waitUntil(kickDeferredImageWorker(userId));
  return c.json(serializeRequest(updated));
});

imagesRoutes.patch("/requests/:id", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");
  const status = requiredEnum(await readJsonObject(c), "status", ["cancelled", "done"] as const);

  const [updated] = await db
    .update(imageGenerationRequests)
    .set({ status, updatedAt: new Date() } as any)
    .where(and(eq(imageGenerationRequests.id, id), eq(imageGenerationRequests.userId, userId)))
    .returning();

  if (!updated) return c.json({ error: "Image request not found" }, 404);
  return c.json(serializeRequest(updated));
});

imagesRoutes.post("/requests/:id/import", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");
  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "No file provided" }, 400);

  const [request] = await db
    .select()
    .from(imageGenerationRequests)
    .where(and(eq(imageGenerationRequests.id, id), eq(imageGenerationRequests.userId, userId)))
    .limit(1);

  if (!request) return c.json({ error: "Image request not found" }, 404);
  if (request.status === "cancelled") return c.json({ error: "Cancelled requests cannot be imported" }, 400);
  if (request.status === "done" && request.importedAssetId) {
    const [asset] = await db.select().from(imageAssets).where(and(
      eq(imageAssets.id, request.importedAssetId),
      eq(imageAssets.userId, userId),
    )).limit(1);
    if (asset) return c.json({ request: serializeRequest(request), asset: serializeAsset(asset), idempotent: true });
  }

  const staleImport = new Date(Date.now() - 15 * 60 * 1000);
  const [claimedRequest] = await db
    .update(imageGenerationRequests)
    .set({ status: "importing", lastError: null, updatedAt: new Date() })
    .where(and(
      eq(imageGenerationRequests.id, id),
      eq(imageGenerationRequests.userId, userId),
      or(
        inArray(imageGenerationRequests.status, ["pending", "queued", "processing", "failed"]),
        and(eq(imageGenerationRequests.status, "importing"), lt(imageGenerationRequests.updatedAt, staleImport)),
      ),
    ))
    .returning();

  if (!claimedRequest) {
    return c.json({ error: request.status === "done" ? "Imported image metadata is incomplete" : "This image request is already being imported" }, 409);
  }

  let buffer: Buffer<ArrayBufferLike> = Buffer.from(await file.arrayBuffer());
  try {
    const sharp = (await import("sharp")).default;
    buffer = await sharp(buffer).webp({ quality: 85 }).toBuffer();
  } catch {}

  const assetOptions = {
    type: request.type,
    prompt: request.prompt,
    altText: request.altText || undefined,
    modelId: `manual/${request.provider}`,
    provider: request.provider,
    aspectRatio: request.aspectRatio || undefined,
    resolution: request.resolution || undefined,
    position: request.position ?? undefined,
    cost: 0,
    sourceUrl: request.sourceUrl || undefined,
    credit: request.credit || undefined,
    licenseLabel: request.licenseLabel || "Manual/local",
    attributionUrl: request.attributionUrl || undefined,
    sourceKind: "manual",
    jobId: request.jobId || undefined,
    postId: request.postId || undefined,
  };

  let storagePath: string | null = null;
  try {
    storagePath = await storeImageBuffer(buffer, userId, `${userId}/manual-imports/${id}.webp`);
    const result = await db.transaction(async (tx) => {
      const [asset] = await tx.insert(imageAssets).values(imageAssetValues(buffer, userId, storagePath!, assetOptions)).returning();
      await attachImageRequestToPost(claimedRequest, storagePath!, "auto", userId, tx);
      const [updated] = await tx
        .update(imageGenerationRequests)
        .set({ status: "done", importedAssetId: asset.id, completedVia: "manual", lastError: null, updatedAt: new Date() })
        .where(and(
          eq(imageGenerationRequests.id, id),
          eq(imageGenerationRequests.userId, userId),
          eq(imageGenerationRequests.status, "importing"),
        ))
        .returning();
      if (!updated) throw new Error("Image import claim expired before completion");
      return { asset, updated };
    });
    return c.json({ request: serializeRequest(result.updated), asset: serializeAsset(result.asset) }, 201);
  } catch (error) {
    let message = error instanceof Error ? error.message : "Image import failed";
    if (storagePath) {
      try {
        await deleteFile(storagePath);
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        message = `${message}; storage cleanup failed: ${cleanupMessage}`;
      }
    }
    await db.update(imageGenerationRequests).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(and(
      eq(imageGenerationRequests.id, id),
      eq(imageGenerationRequests.userId, userId),
      eq(imageGenerationRequests.status, "importing"),
    ));
    return c.json({ error: message }, 500);
  }
});

imagesRoutes.delete("/:id", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");

  const [asset] = await db.update(imageAssets).set({ status: "deleting" }).where(and(
    eq(imageAssets.id, id),
    eq(imageAssets.userId, userId),
    ne(imageAssets.status, "deleting"),
  )).returning();

  if (!asset) return c.json({ error: "Image not found" }, 404);

  try {
    await deleteFile(asset.storagePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Storage deletion failed";
    await db.update(imageAssets).set({ status: "delete_failed" }).where(and(eq(imageAssets.id, id), eq(imageAssets.userId, userId)));
    return c.json({ error: message, failed: [id] }, 502);
  }

  try {
    await db.transaction(async (tx) => {
      await detachDeletedAsset(tx, asset, userId);
      await tx.delete(imageAssets).where(and(eq(imageAssets.id, id), eq(imageAssets.userId, userId)));
    });
  } catch (error) {
    await db.update(imageAssets).set({ status: "delete_failed" }).where(and(eq(imageAssets.id, id), eq(imageAssets.userId, userId)));
    return c.json({ error: error instanceof Error ? error.message : "Image metadata deletion failed", failed: [id] }, 500);
  }
  return c.json({ success: true });
});

imagesRoutes.post("/bulk-delete", async (c) => {
  const userId = getUserId(c);
  const ids = requiredStringArray(await readJsonObject(c), "ids");

  const assets = await db.update(imageAssets).set({ status: "deleting" }).where(and(
    inArray(imageAssets.id, ids),
    eq(imageAssets.userId, userId),
    ne(imageAssets.status, "deleting"),
  )).returning();

  const deletionResults = await Promise.allSettled(assets.map((asset) => deleteFile(asset.storagePath)));
  const partition = partitionSettled(assets, deletionResults);
  const deletedAssets = partition.completed;
  const failedAssets = partition.failed.map(({ item }) => item);

  if (failedAssets.length) {
    await db.update(imageAssets).set({ status: "delete_failed" }).where(and(
      inArray(imageAssets.id, failedAssets.map((asset) => asset.id)),
      eq(imageAssets.userId, userId),
    ));
  }

  try {
    if (deletedAssets.length) {
      await db.transaction(async (tx) => {
        for (const asset of deletedAssets) await detachDeletedAsset(tx, asset, userId);
        await tx.delete(imageAssets).where(and(
          inArray(imageAssets.id, deletedAssets.map((asset) => asset.id)),
          eq(imageAssets.userId, userId),
        ));
      });
    }
  } catch (error) {
    await db.update(imageAssets).set({ status: "delete_failed" }).where(and(
      inArray(imageAssets.id, deletedAssets.map((asset) => asset.id)),
      eq(imageAssets.userId, userId),
    ));
    return c.json({ error: error instanceof Error ? error.message : "Image metadata deletion failed", deleted: 0, failed: assets.map((asset) => asset.id) }, 500);
  }

  const failed = partition.failed.map(({ item, error }) => ({ id: item.id, error }));
  return c.json({ success: failed.length === 0, deleted: deletedAssets.length, failed }, failed.length ? 207 : 200);
});

imagesRoutes.post("/:id/detach", async (c) => {
  const userId = getUserId(c);
  const id = c.req.param("id");

  const [updated] = await db
    .update(imageAssets)
    .set({ postId: null, status: "unused" })
    .where(and(eq(imageAssets.id, id), eq(imageAssets.userId, userId)))
    .returning();

  if (!updated) return c.json({ error: "Image not found" }, 404);
  return c.json(updated);
});

imagesRoutes.post("/upload", async (c) => {
  const userId = getUserId(c);
  const { uploadFile } = await import("../services/image-storage.js");
  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "No file provided" }, 400);

  const result = await uploadFile(file, userId);
  return c.json(result, 201);
});
