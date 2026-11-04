// Vendored from Lindevo packages/mdx/src/lint/issue.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
/** A lint finding before it is stamped with the locale it came from. */
export interface RawIssue {
  col: number;
  hint?: string;
  line: number;
  message: string;
  rule: string;
  severity: "error" | "warning";
}

export function issueAt(
  at: { col: number; line: number },
  rule: string,
  message: string,
  hint?: string
): RawIssue {
  return {
    col: at.col,
    line: at.line,
    message,
    rule,
    severity: "error",
    ...(hint ? { hint } : {}),
  };
}
