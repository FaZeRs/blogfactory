// Vendored from Lindevo packages/mdx/src/lint.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { maskForScan, normalizeNewlines, scanTags } from "./lib/tags.js";
import { checkBodies, checkStepTags } from "./lint/body.js";
import { lintFaq } from "./lint/faq-rules.js";
import { lintHeadings } from "./lint/headings.js";
import type { RawIssue } from "./lint/issue.js";
import { lintParity } from "./lint/parity.js";
import {
  splitSourcesSection as splitSources,
  stripToPlainText,
  dropSourcesSection as withoutSourcesSection,
} from "./lint/plain-text.js";
import {
  buildComponentTree,
  type ComponentUse,
  checkBlankLines,
  checkContainerOpenings,
  checkCounts,
  checkProvenanceLast,
} from "./lint/structure.js";

export interface LintIssue {
  col: number;
  hint?: string;
  line: number;
  locale: "en" | "lv";
  message: string;
  rule: string;
  severity: "error" | "warning";
}

export interface LintResult {
  issues: LintIssue[];
  ok: boolean;
}

type Locale = LintIssue["locale"];

function byPosition(a: LintIssue, b: LintIssue): number {
  return a.line - b.line || a.col - b.col;
}

function lintLocale(
  input: string,
  locale: Locale
): { issues: LintIssue[]; uses: ComponentUse[] } {
  const markdown = normalizeNewlines(input);
  const masked = maskForScan(markdown);
  const tree = buildComponentTree(scanTags(markdown));
  const raw: RawIssue[] = [
    ...tree.issues,
    ...checkContainerOpenings(tree.uses, markdown),
    ...checkBodies(tree.uses, markdown),
    ...checkStepTags(tree.uses, markdown),
    ...checkCounts(tree.uses, masked),
    ...checkBlankLines(tree.uses, markdown),
    ...checkProvenanceLast(tree.uses, markdown),
    ...lintHeadings(masked, tree.uses),
    ...lintFaq(markdown),
  ];
  const issues = raw.map((issue) => ({ ...issue, locale })).sort(byPosition);
  return { issues, uses: tree.uses };
}

/**
 * Checks article markdown against the component spec before it is saved.
 * `ok` is false when any issue is an error; warnings never block.
 */
export function lintArticle(input: { en: string; lv?: string }): LintResult {
  const en = lintLocale(input.en, "en");
  const issues = [...en.issues];
  if (input.lv !== undefined && input.lv.trim() !== "") {
    const lv = lintLocale(input.lv, "lv");
    issues.push(
      ...lv.issues,
      ...lintParity(en.uses, lv.uses).map((issue) => ({
        ...issue,
        locale: "lv" as const,
      }))
    );
  }
  return {
    issues,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
}

/** One line per issue: "[en 12:3] error unknown-tag: … (hint)". */
export function formatIssues(issues: LintIssue[]): string {
  return issues
    .map((issue) => {
      const hint = issue.hint ? ` (${issue.hint})` : "";
      return `[${issue.locale} ${issue.line}:${issue.col}] ${issue.severity} ${issue.rule}: ${issue.message}${hint}`;
    })
    .join("\n");
}

/** Strips components and markdown down to the prose a reader sees. */
export function toPlainText(markdown: string): string {
  return stripToPlainText(markdown);
}

export type { SourcesSection } from "./lint/plain-text.js";

/** The article split into its body and its `## Sources` / `## Avoti` section; `body` equals `dropSourcesSection`. */
export function splitSourcesSection(markdown: string) {
  return splitSources(markdown);
}

/** The article without its `## Sources` or `## Avoti` section (the list the content engine appends). */
export function dropSourcesSection(markdown: string): string {
  return withoutSourcesSection(markdown);
}
