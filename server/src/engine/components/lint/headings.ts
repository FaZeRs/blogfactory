// Vendored from Lindevo packages/mdx/src/lint/headings.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { lineStarts } from "../lib/tags.js";
import { issueAt, type RawIssue } from "./issue.js";
import type { ComponentUse } from "./structure.js";

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

function insideComponent(uses: ComponentUse[], index: number): boolean {
  return uses.some(
    (use) => use.close && index > use.open.end && index < use.close.index
  );
}

/**
 * The page renders the title as the only h1, so article headings start at h2,
 * never skip a level, and never sit inside a component.
 */
export function lintHeadings(masked: string, uses: ComponentUse[]): RawIssue[] {
  const issues: RawIssue[] = [];
  const starts = lineStarts(masked);
  let previous = 1;
  for (const [lineIndex, line] of masked.split("\n").entries()) {
    const level = ATX_RE.exec(line)?.[1]?.length;
    if (level === undefined) {
      continue;
    }
    const at = { col: 1, line: lineIndex + 1 };
    if (level === 1) {
      issues.push(
        issueAt(
          at,
          "no-h1",
          "Articles must not use a level-1 heading.",
          "The page title is the h1; start sections at ##."
        )
      );
    } else if (level > previous + 1) {
      issues.push(
        issueAt(
          at,
          "heading-skip",
          `Heading jumps from level ${previous} to ${level}.`,
          `Use ${"#".repeat(previous + 1)} here.`
        )
      );
    }
    if (insideComponent(uses, starts[lineIndex] ?? 0)) {
      issues.push(
        issueAt(
          at,
          "heading-in-component",
          "Headings cannot sit inside a component."
        )
      );
    }
    previous = level;
  }
  return issues;
}
