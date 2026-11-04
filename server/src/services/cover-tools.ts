import { queueDeferredImageRequest, kickDeferredImageWorker } from "./ai-image-queue.js";
import { buildImageAltText, buildImagePrompt } from "./image-slots.js";

export const COVER_PRESETS = [
  { id: "site_default", label: "Site default", style: "" },
  { id: "editorial_photo", label: "Editorial photo", style: "Realistic editorial photograph, natural light, shallow depth of field." },
  { id: "flat_illustration", label: "Flat illustration", style: "Flat vector illustration, simple shapes, limited palette." },
  { id: "3d_render", label: "3D render", style: "Soft 3D render, clean studio lighting, matte materials." },
  { id: "abstract", label: "Abstract", style: "Abstract composition of shapes and gradients that suggests the topic." },
  { id: "brand_colors", label: "Brand colors", style: "" },
] as const;

export type CoverPresetId = (typeof COVER_PRESETS)[number]["id"];

/** Values allowed as the saved site default: any preset except itself, or "custom" (the Article Settings style text). */
export const COVER_STYLE_DEFAULTS = [...COVER_PRESETS.filter((p) => p.id !== "site_default").map((p) => p.id), "custom"] as string[];

export function isCoverPresetId(value: unknown): value is CoverPresetId {
  return COVER_PRESETS.some((p) => p.id === value);
}

export type CoverSettings = {
  imageStylePrompt?: string | null;
  brandCompanyName?: string | null;
  brandDescription?: string | null;
  imageAdvancedOptions?: unknown;
};

export function siteDefaultCoverStyle(settings: CoverSettings) {
  const options = settings.imageAdvancedOptions;
  const value = options && typeof options === "object" && !Array.isArray(options) ? (options as Record<string, unknown>).coverStylePreset : undefined;
  return typeof value === "string" && COVER_STYLE_DEFAULTS.includes(value) ? value : "custom";
}

function styleFor(preset: string, settings: CoverSettings): string {
  const custom = settings.imageStylePrompt?.trim() || "";
  if (preset === "site_default") return styleFor(siteDefaultCoverStyle(settings), settings);
  if (preset === "brand_colors") {
    const brand = [settings.brandCompanyName?.trim(), settings.brandDescription?.trim()].filter(Boolean).join(": ");
    return [brand && `On-brand visual for ${brand}. Use the brand's colors and tone.`, custom].filter(Boolean).join(" ") || "Clean on-brand visual in the brand's colors.";
  }
  return COVER_PRESETS.find((p) => p.id === preset)?.style || custom;
}

export function coverPromptDraft(opts: { title: string; content: string; preset: string; settings: CoverSettings }) {
  return buildImagePrompt({ content: opts.content, title: opts.title, type: "cover", stylePrompt: styleFor(opts.preset, opts.settings) });
}

/** Returns the cleaned prompt, or null when it is too short. */
export function cleanCoverPrompt(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim().slice(0, 2000).trim();
  return cleaned.length >= 10 ? cleaned : null;
}

export function adjustCoverPrompt(instruction: string) {
  return `Edit this image: ${instruction}. Keep the composition and subject unless the instruction says otherwise. No text, logos or watermarks.`;
}

export function coverResolution(settings: { imageAdvancedOptions?: unknown }) {
  const options = settings.imageAdvancedOptions as Record<string, unknown> | null | undefined;
  return options && options.coverResolution === "512" ? "512" : "1K";
}

/** Queues `count` new cover requests for a post; finished images become the cover only if it has not changed since. */
export async function queueCoverRequests(opts: {
  userId: string;
  post: { id: string; title: string; content: string | null; jobId: string | null; coverImageUrl: string | null };
  settings: CoverSettings & { imageModel: string };
  prompt: string;
  count?: number;
  referencePath?: string | null;
}) {
  const slot = {
    type: "cover" as const, position: 0, aspectRatio: "16:9", resolution: coverResolution(opts.settings), prompt: opts.prompt,
    altText: buildImageAltText({ title: opts.post.title, type: "cover", content: opts.post.content || "" }),
  };
  const ids: string[] = [];
  for (let i = 0; i < (opts.count ?? 1); i++) {
    const queued = await queueDeferredImageRequest({
      userId: opts.userId, postId: opts.post.id, jobId: opts.post.jobId, imageModel: opts.settings.imageModel, slot, force: true,
      referencePath: opts.referencePath ?? null, replacesCover: opts.post.coverImageUrl ?? null,
    });
    if (queued.id) ids.push(queued.id);
  }
  await kickDeferredImageWorker(opts.userId);
  return ids;
}
