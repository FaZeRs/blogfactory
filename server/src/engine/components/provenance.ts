// The provenance tag, after Lindevo apps/content-engine/src/core/provenance.ts (renderProvenanceTag, esc, upsertProvenanceTag).

const esc = (s: string) => s.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Provenance = { sources: number; checks: number; reviewed: string; models: string[] };

export function provenanceTag(p: Provenance): string {
  const attrs = [`sources="${p.sources}"`, `checks="${p.checks}"`, `reviewed="${esc(p.reviewed)}"`];
  if (p.models.length) attrs.push(`models="${esc(p.models.join(", "))}"`);
  return `<provenance ${attrs.join(" ")}></provenance>`;
}

/** The tag appended at the end after a blank line (component spec: at most one, last). Existing tags are the caller's to avoid: the engine's draft never has one. */
export const appendProvenance = (markdown: string, tag: string) => `${markdown.trimEnd()}\n\n${tag}\n`;
