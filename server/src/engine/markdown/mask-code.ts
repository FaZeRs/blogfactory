// Exported so the linter can reuse the exact patterns the renderer uses. The
// global ones (`g`) keep `lastIndex` state: use them with `replace` or
// `matchAll`, never with `exec` or `test`.
export const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
export const INLINE_CODE_RE = /(`+)[^`\n][\s\S]*?\1/g;
export const COMMENT_RE = /<!--[\s\S]*?-->/g;
export const NOT_NEWLINE_RE = /[^\n]/g;

/** Replaces every character except newlines with a space. */
export function blankOut(text: string): string {
  return text.replace(NOT_NEWLINE_RE, " ");
}

/**
 * Blanks out fenced code, inline code and HTML comments while keeping every
 * index and line number, so tag scanners never mistake `<workflow>` inside a
 * code sample for a real component.
 */
export function maskCode(src: string): string {
  let fence: string | null = null;
  const lines = src.replace(COMMENT_RE, blankOut).split("\n");
  const masked = lines.map((line) => {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      return blankOut(line);
    }
    if (marker) {
      fence = marker;
      return blankOut(line);
    }
    return line.replace(INLINE_CODE_RE, blankOut);
  });
  return masked.join("\n");
}
