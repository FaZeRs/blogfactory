// Vendored from Lindevo packages/mdx/src/plugins/containers.ts (copied 2026-11-05): only CONTAINER_TAGS and OPEN_RE, without the marked renderer. Keep in sync with Lindevo.
export const CONTAINER_TAGS = [
  "key-takeaways",
  "tour",
  "tour-step",
  "workflow",
  "workflow-step",
] as const;
export type ContainerTag = (typeof CONTAINER_TAGS)[number];

// Longest name first, so `workflow-step` is never read as `workflow` (nor `tour-step` as `tour`).
const TAG_NAMES = [...CONTAINER_TAGS]
  .sort((a, b) => b.length - a.length)
  .join("|");

// Exported so the linter reads tags exactly the way the renderer does. The
// global ones (`g`) keep `lastIndex` state: use them with `replace` or
// `matchAll`, never with `exec` or `test`.
export const OPEN_RE = new RegExp(
  `^<(${TAG_NAMES})((?:\\s+[a-zA-Z][\\w-]*(?:\\s*=\\s*"[^"]*")?)*)\\s*>[ \\t]*(?:\\n|$)`
);
