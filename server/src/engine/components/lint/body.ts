// Vendored from Lindevo packages/mdx/src/lint/body.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { blankOut, COMMENT_RE } from "../lib/mask-code.js";
import { lineStarts, positionOf, type TagEvent } from "../lib/tags.js";
import { issueAt, type RawIssue } from "./issue.js";
import type { ComponentUse } from "./structure.js";

/**
 * Content the renderer would drop or put where it does not belong, which the
 * tag-and-attribute checks cannot see:
 *
 * - text inside a leaf whose spec says `body: "none"` (`service-cta`,
 *   `provenance`, `case-stat`, …): the component ignores its children, so the
 *   words silently disappear;
 * - text directly inside a container that may only hold its declared children
 *   (`workflow`, `case-stats`, `files`, `folder`): it lands between the list
 *   items or rows the component builds from them;
 * - in `steps`, whose children are titles: the markdown after a `<step>` title
 *   is that step's body, but text before the first title belongs to no step
 *   and is dropped, and a title tag written any other way than `<step>` and
 *   `</step>` is not split out, which drops every step.
 *
 * Comments and whitespace are not text. Code is: a code sample in any of these
 * places is dropped or misplaced just the same.
 */

const TEXT_RE = /\S/;
const STEP_OPEN = "<step>";
const STEP_CLOSE = "</step>";

/** The index of the first character in `start..end` that is neither space nor comment, or -1. */
function firstText(source: string, start: number, end: number): number {
  const found = TEXT_RE.exec(
    source.slice(start, end).replace(COMMENT_RE, blankOut)
  );
  return found ? start + found.index : -1;
}

/** Where a component's last tag ends; null while it is still open. */
function endIndex(use: ComponentUse): number | null {
  if (use.close) {
    return use.close.end;
  }
  return use.open.selfClosing ? use.open.end : null;
}

function leafBodyIssue(
  use: ComponentUse,
  source: string,
  starts: number[]
): RawIssue | null {
  if (!use.close) {
    return null;
  }
  const at = firstText(source, use.open.end, use.close.index);
  if (at === -1) {
    return null;
  }
  const { tag } = use.spec;
  return issueAt(
    positionOf(starts, at),
    "unexpected-body",
    `<${tag}> shows nothing written between its tags, so this text would not appear.`,
    `Write <${tag} …></${tag}> with nothing in between. Put the words in an attribute, or in the article before or after it.`
  );
}

/** The stretches of a container between its open tag, its children and its close tag. */
function gapsBetweenChildren(use: ComponentUse): [number, number][] | null {
  if (!use.close) {
    return null;
  }
  const gaps: [number, number][] = [];
  let from = use.open.end;
  for (const child of use.children) {
    const childEnd = endIndex(child);
    if (childEnd === null) {
      // An unclosed child is reported already; its extent is unknown.
      return null;
    }
    gaps.push([from, child.open.index]);
    from = childEnd;
  }
  gaps.push([from, use.close.index]);
  return gaps;
}

function containerTextIssue(
  use: ComponentUse,
  source: string,
  starts: number[]
): RawIssue | null {
  const { tag } = use.spec;
  const children = (use.spec.children ?? [])
    .map((child) => `<${child}>`)
    .join(" or ");
  for (const [start, end] of gapsBetweenChildren(use) ?? []) {
    const at = firstText(source, start, end);
    if (at !== -1) {
      return issueAt(
        positionOf(starts, at),
        "unexpected-text",
        `<${tag}> can only hold ${children} blocks; this text is outside them.`,
        `Move it into one of them, or out of the <${tag}>.`
      );
    }
  }
  return null;
}

/** Text in a `steps` before its first `<step>` title (all of it, with no title). */
function stepsLeadIssue(
  use: ComponentUse,
  source: string,
  starts: number[]
): RawIssue | null {
  if (!use.close) {
    return null;
  }
  const end = use.children[0]?.open.index ?? use.close.index;
  const at = firstText(source, use.open.end, end);
  if (at === -1) {
    return null;
  }
  return issueAt(
    positionOf(starts, at),
    "unexpected-text",
    "<steps> starts with a <step> title; text before the first one would not appear.",
    "Start with <step>Title</step>, then write that step's body under it."
  );
}

function bodyIssue(
  use: ComponentUse,
  source: string,
  starts: number[]
): RawIssue | null {
  const { spec } = use;
  if (spec.kind === "leaf" && spec.body === "none") {
    return leafBodyIssue(use, source, starts);
  }
  if (spec.tag === "steps") {
    return stepsLeadIssue(use, source, starts);
  }
  return spec.children ? containerTextIssue(use, source, starts) : null;
}

export function checkBodies(uses: ComponentUse[], source: string): RawIssue[] {
  const starts = lineStarts(source);
  return uses.flatMap((use) => bodyIssue(use, source, starts) ?? []);
}

/**
 * The steps renderer splits titles on the literal `<step>` and `</step>`, so a
 * title tag in another case, or with anything else inside it, is not one.
 */
export function checkStepTags(
  uses: ComponentUse[],
  source: string
): RawIssue[] {
  const issues: RawIssue[] = [];
  const report = (at: TagEvent, written: string) =>
    issues.push(
      issueAt(
        at,
        "unknown-tag",
        `${written} is not read as a step title.`,
        "Write it as <step>Title</step>: lowercase, with nothing else inside the tags."
      )
    );
  for (const { close, open, spec } of uses) {
    if (spec.tag !== "step") {
      continue;
    }
    const opening = source.slice(open.index, open.end);
    const closing = close ? source.slice(close.index, close.end) : null;
    // The opening tag first: when it is not read, the close is not either. An
    // unclosed step is reported as such already.
    if (opening !== STEP_OPEN) {
      report(open, opening);
    } else if (close && closing !== STEP_CLOSE) {
      report(close, closing ?? "");
    }
  }
  return issues;
}
