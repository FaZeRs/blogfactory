export function reviewDeliveryState(input: {
  hasPermission: boolean;
  hasBlockers: boolean;
  destinationId: string;
}) {
  if (!input.hasPermission) return { allowed: false, reason: "read_only" as const };
  if (input.hasBlockers) return { allowed: false, reason: "blocker" as const };
  if (!input.destinationId) return { allowed: false, reason: "destination_required" as const };
  return { allowed: true, reason: null };
}

// Host label for a source link; null for anything that is not a plain http(s) URL, so it is never rendered as a link.
export function sourceHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export function cmsDraftSuccessMessage(deduplicated: boolean) {
  return `CMS draft ready.${deduplicated ? " Existing draft reused." : ""}`;
}

export function toolResultError(value: unknown) {
  const structured = value && typeof value === "object" ? (value as { structuredContent?: unknown }).structuredContent : null;
  if (!structured || typeof structured !== "object") return null;
  const error = (structured as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof code !== "string" || typeof message !== "string") return null;
  const nextAction = (structured as { next_action?: unknown }).next_action;
  return { code, message, nextAction: typeof nextAction === "string" ? nextAction : null };
}
