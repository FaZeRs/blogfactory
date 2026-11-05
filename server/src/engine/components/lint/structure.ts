// Vendored from Lindevo packages/mdx/src/lint/structure.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import {
  type AttrSpec,
  type ComponentSpec,
  getComponentSpec,
  PLAIN_HTML_ALLOWLIST,
} from "../component-spec.js";
import { COMMENT_RE } from "../../markdown/mask-code.js";
import {
  lineStarts,
  notDoubleQuoted,
  positionOf,
  type TagEvent,
} from "../lib/tags.js";
import { CONTAINER_TAGS, OPEN_RE } from "../containers.js";
import { issueAt, type RawIssue } from "./issue.js";

/** One component as it appears in an article, with its nesting resolved. */
export interface ComponentUse {
  children: ComponentUse[];
  close: TagEvent | null;
  open: TagEvent;
  parent: ComponentUse | null;
  spec: ComponentSpec;
}

const INT_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A list item marker, with the indent in group 1.
const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\S/;
const BLANK_LINE_RE = /^\s*$/;
// One "/" then a path: not "//host", not "/\host" (browsers read both as a
// host), and no whitespace, which browsers strip from URLs.
const SITE_PATH_RE = /^\/(?![/\\])\S*$/;
export const WORKFLOW_STEPS = { max: 8, min: 2 };
/** Containers whose step children share the WORKFLOW_STEPS limits. */
const STEP_CHILD: Record<string, string> = {
  tour: "tour-step",
  workflow: "workflow-step",
};
export const TAKEAWAYS = { max: 5, min: 3 };
const CONTAINER_NAMES: readonly string[] = CONTAINER_TAGS;
// A private copy of the renderer's pattern for a container's opening tag, so
// the linter accepts exactly what the renderer turns into a component.
const RENDERER_OPEN_RE = new RegExp(OPEN_RE.source, OPEN_RE.flags);

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function intProblem(spec: { min?: number }, value: string): string | null {
  if (!INT_RE.test(value)) {
    return "must be a whole number";
  }
  if (spec.min !== undefined && Number(value) < spec.min) {
    return `must be at least ${spec.min}`;
  }
  return null;
}

/**
 * A required text attribute is what the component shows (a reviewer's name, a
 * step's title), so an empty one renders a hole. Only `allowEmpty` ones (an
 * image's alt, empty for a decorative image) may be blank.
 */
function stringProblem(
  spec: Extract<AttrSpec, { type: "string" }>,
  value: string
): string | null {
  if (spec.required && !spec.allowEmpty && value.trim() === "") {
    return "must not be empty";
  }
  return spec.maxLength !== undefined && value.length > spec.maxLength
    ? `is longer than ${spec.maxLength} characters`
    : null;
}

function attrProblem(spec: AttrSpec, value: string | true): string | null {
  if (spec.type === "boolean") {
    return null;
  }
  if (value === true) {
    return "needs a value";
  }
  switch (spec.type) {
    case "string":
      return stringProblem(spec, value);
    case "enum":
      return spec.values.includes(value) || spec.aliases?.includes(value)
        ? null
        : `must be one of: ${spec.values.join(", ")}`;
    case "int":
      return intProblem(spec, value);
    case "date":
      return isRealDate(value) ? null : "must be a date written YYYY-MM-DD";
    case "csv":
      return value.trim() === "" ? "must not be empty" : null;
    default:
      return null;
  }
}

/** Rules the spec's attribute types cannot express. */
function extraAttrProblem(
  spec: ComponentSpec,
  name: string,
  value: string
): string | null {
  if (spec.tag === "provenance" && name === "case-study") {
    // The value is an HTML attribute, so "&#47;", "&#x2f;", "&sol;" and
    // "&#92;" become "/" and "\" after the path check would have passed them.
    // Rather than decode references, a "&" is not accepted at all.
    if (value.includes("&")) {
      return 'must not contain "&", which HTML turns into other characters';
    }
    return SITE_PATH_RE.test(value)
      ? null
      : 'must be a path on this site, starting with a single "/"';
  }
  return null;
}

function checkAttrs(spec: ComponentSpec, event: TagEvent): RawIssue[] {
  const issues: RawIssue[] = [];
  for (const [name, value] of event.attrs) {
    // `hasOwn`, so names like "constructor" are not read off the prototype.
    const attrSpec = Object.hasOwn(spec.attrs, name)
      ? spec.attrs[name]
      : undefined;
    if (!attrSpec) {
      const allowed = Object.keys(spec.attrs).join(", ") || "none";
      issues.push(
        issueAt(
          event,
          "unknown-attr",
          `<${spec.tag}> has no attribute "${name}".`,
          `Allowed: ${allowed}.`
        )
      );
      continue;
    }
    const problem =
      attrProblem(attrSpec, value) ??
      (typeof value === "string" ? extraAttrProblem(spec, name, value) : null);
    if (problem) {
      issues.push(
        issueAt(
          event,
          "invalid-attr-value",
          `<${spec.tag}> ${name} ${problem}.`
        )
      );
    }
  }
  for (const [name, attrSpec] of Object.entries(spec.attrs)) {
    if (attrSpec.required && !event.attrs.has(name)) {
      issues.push(
        issueAt(
          event,
          "missing-attr",
          `<${spec.tag}> needs a ${name} attribute.`
        )
      );
    }
  }
  return issues;
}

function placementIssues(
  spec: ComponentSpec,
  parent: ComponentUse | null,
  event: TagEvent
): RawIssue[] {
  const issues: RawIssue[] = [];
  if (spec.parents && !(parent && spec.parents.includes(parent.spec.tag))) {
    const where = spec.parents.map((tag) => `<${tag}>`).join(" or ");
    issues.push(
      issueAt(event, "invalid-parent", `<${spec.tag}> belongs inside ${where}.`)
    );
  }
  const allowed = parent?.spec.children;
  if (parent && allowed && !allowed.includes(spec.tag)) {
    issues.push(
      issueAt(
        event,
        "invalid-child",
        `<${parent.spec.tag}> cannot contain <${spec.tag}>.`,
        `Allowed inside: ${allowed.join(", ")}.`
      )
    );
  }
  if (event.selfClosing) {
    issues.push(
      issueAt(
        event,
        "self-closing-tag",
        `Write <${spec.tag} …></${spec.tag}>, not a self-closing tag.`
      )
    );
  }
  return issues;
}

function lastIndexOfTag(stack: ComponentUse[], name: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.spec.tag.toLowerCase() === name) {
      return index;
    }
  }
  return -1;
}

function closeComponent(
  event: TagEvent,
  stack: ComponentUse[],
  issues: RawIssue[]
): void {
  const depth = lastIndexOfTag(stack, event.name);
  if (depth === -1) {
    issues.push(
      issueAt(
        event,
        "unexpected-close-tag",
        `</${event.rawName}> has no matching opening tag.`
      )
    );
    return;
  }
  for (const unclosed of stack.splice(depth + 1)) {
    issues.push(
      issueAt(
        unclosed.open,
        "unclosed-tag",
        `<${unclosed.spec.tag}> is not closed before </${event.rawName}>.`,
        `Add </${unclosed.spec.tag}> first.`
      )
    );
  }
  const use = stack.pop();
  if (use) {
    use.close = event;
  }
}

/**
 * An unknown tag is reported where it opens. Its close tag is reported only
 * when nothing of that name was opened before it, i.e. when it is stray.
 */
function unknownTagIssue(
  event: TagEvent,
  openedUnknown: Set<string>
): RawIssue | null {
  if (PLAIN_HTML_ALLOWLIST.includes(event.name)) {
    return null;
  }
  if (event.closing && openedUnknown.has(event.name)) {
    return null;
  }
  if (!event.closing) {
    openedUnknown.add(event.name);
  }
  const shown = event.closing ? `</${event.rawName}>` : `<${event.rawName}>`;
  return issueAt(
    event,
    "unknown-tag",
    `Unknown tag ${shown}.`,
    "Use a component from packages/mdx/COMPONENTS.md, or wrap code in backticks."
  );
}

/** Resolves nesting and checks tags, attributes and placement. */
export function buildComponentTree(events: TagEvent[]): {
  issues: RawIssue[];
  uses: ComponentUse[];
} {
  const issues: RawIssue[] = [];
  const uses: ComponentUse[] = [];
  const stack: ComponentUse[] = [];
  const openedUnknown = new Set<string>();

  for (const event of events) {
    const spec = getComponentSpec(event.name);
    if (!spec) {
      const unknown = unknownTagIssue(event, openedUnknown);
      if (unknown) {
        issues.push(unknown);
      }
      continue;
    }
    if (event.closing) {
      closeComponent(event, stack, issues);
      continue;
    }
    const parent = stack.at(-1) ?? null;
    issues.push(
      ...checkAttrs(spec, event),
      ...placementIssues(spec, parent, event)
    );
    const use: ComponentUse = {
      children: [],
      close: null,
      open: event,
      parent,
      spec,
    };
    parent?.children.push(use);
    uses.push(use);
    if (!event.selfClosing) {
      stack.push(use);
    }
  }

  for (const unclosed of stack) {
    issues.push(
      issueAt(
        unclosed.open,
        "unclosed-tag",
        `<${unclosed.spec.tag}> is never closed.`,
        `Add </${unclosed.spec.tag}>.`
      )
    );
  }
  return { issues, uses };
}

/** The tag that ends a component: its close tag, or itself when self-closed. */
function endOf(use: ComponentUse): TagEvent | null {
  return use.close ?? (use.open.selfClosing ? use.open : null);
}

/** Top-level list items in a block of text (nested items are not counted). */
function countListItems(text: string): number {
  let base: number | null = null;
  let count = 0;
  for (const line of text.split("\n")) {
    const indent = LIST_ITEM_RE.exec(line)?.[1]?.replaceAll(
      "\t",
      "    "
    ).length;
    if (indent === undefined) {
      continue;
    }
    base ??= indent;
    if (indent <= base) {
      count += 1;
    }
  }
  return count;
}

function countIssue(
  use: ComponentUse,
  found: number,
  limits: { max: number; min: number },
  rule: string,
  what: string
): RawIssue[] {
  if (found >= limits.min && found <= limits.max) {
    return [];
  }
  return [
    issueAt(
      use.open,
      rule,
      `<${use.spec.tag}> needs ${limits.min} to ${limits.max} ${what}; found ${found}.`
    ),
  ];
}

/**
 * Per-article maximums and the child counts the renderers rely on. `masked` is
 * the article with code blanked out, so a list in a code sample is not counted.
 */
export function checkCounts(uses: ComponentUse[], masked: string): RawIssue[] {
  const issues: RawIssue[] = [];
  const seen = new Map<string, number>();
  for (const use of uses) {
    const count = (seen.get(use.spec.tag) ?? 0) + 1;
    seen.set(use.spec.tag, count);
    const max = use.spec.maxCount;
    if (max !== undefined && count === max + 1) {
      issues.push(
        issueAt(
          use.open,
          "max-count",
          `Only ${max} <${use.spec.tag}> allowed per article.`
        )
      );
    }
    const stepTag = STEP_CHILD[use.spec.tag];
    if (stepTag) {
      const steps = use.children.filter(
        (child) => child.spec.tag === stepTag
      ).length;
      issues.push(
        ...countIssue(
          use,
          steps,
          WORKFLOW_STEPS,
          `${stepTag}-count`,
          `<${stepTag}> children`
        )
      );
    }
    if (use.spec.tag === "key-takeaways" && use.close) {
      const items = countListItems(masked.slice(use.open.end, use.close.index));
      issues.push(
        ...countIssue(use, items, TAKEAWAYS, "takeaways-count", "list items")
      );
    }
  }
  return issues;
}

/** Top-level blocks stand alone: own line, blank line before and after. */
export function checkBlankLines(
  uses: ComponentUse[],
  source: string
): RawIssue[] {
  const issues: RawIssue[] = [];
  const lines = source.split("\n");
  const starts = lineStarts(source);
  for (const use of uses) {
    const end = endOf(use);
    if (use.parent || !end) {
      continue;
    }
    const last = positionOf(starts, end.end);
    const before = lines[use.open.line - 2];
    const restOfLine = (lines[last.line - 1] ?? "").slice(last.col - 1);
    const after = lines[last.line];
    const ok =
      use.open.col === 1 &&
      (before === undefined || BLANK_LINE_RE.test(before)) &&
      BLANK_LINE_RE.test(restOfLine) &&
      (after === undefined || BLANK_LINE_RE.test(after));
    if (!ok) {
      issues.push(
        issueAt(
          use.open,
          "blank-lines",
          `<${use.spec.tag}> must sit on its own lines with a blank line before and after it.`
        )
      );
    }
  }
  return issues;
}

/** The tag is not lowercase, which the renderer's tokenizer requires. */
function caseIssues({ open, spec }: ComponentUse): RawIssue[] {
  if (open.rawName === spec.tag) {
    return [];
  }
  return [
    issueAt(
      open,
      "unknown-tag",
      `<${open.rawName}> is not read as a component.`,
      `Write the tag name in lowercase: <${spec.tag}>.`
    ),
  ];
}

/** Single-quoted and bare values: only double quotes are read in a container. */
function quoteIssues({ open, spec }: ComponentUse): RawIssue[] {
  return notDoubleQuoted(open.attrSource).map((name) =>
    issueAt(
      open,
      "invalid-attr-value",
      `<${spec.tag}> ${name} must be written in double quotes.`,
      `Write ${name}="…". Without double quotes this tag is not read as a component and shows up as raw HTML.`
    )
  );
}

/** What stops the renderer reading a container's opening tag, if anything. */
function containerOpeningIssues(
  use: ComponentUse,
  source: string,
  starts: number[]
): RawIssue[] {
  const { open, spec } = use;
  const lineEnd = source.indexOf("\n", open.end);
  const opening = source.slice(
    starts[open.line - 1] ?? open.index,
    lineEnd === -1 ? undefined : lineEnd + 1
  );
  if (RENDERER_OPEN_RE.test(opening)) {
    return [];
  }
  const issues = [...caseIssues(use), ...quoteIssues(use)];
  const afterTag = source.slice(
    open.end,
    lineEnd === -1 ? source.length : lineEnd
  );
  // A top-level block that does not start its line is reported by
  // checkBlankLines already; a nested one is only caught here.
  const misplaced = open.col !== 1;
  const nestedMisplaced = misplaced && use.parent !== null;
  if (nestedMisplaced || !BLANK_LINE_RE.test(afterTag)) {
    issues.push(
      issueAt(
        open,
        "blank-lines",
        `<${spec.tag}> must start its own line, with nothing after the opening tag.`,
        "Put the content on the next line."
      )
    );
  }
  if (issues.length === 0 && !misplaced) {
    issues.push(
      issueAt(
        open,
        "invalid-attr-value",
        `<${spec.tag}> is not written the way the renderer reads it.`,
        'Separate attributes with spaces and write each as name="value".'
      )
    );
  }
  return issues;
}

/**
 * The renderer turns a container into a component only when its opening tag is
 * written exactly the way its tokenizer expects. Anything else falls back to
 * raw HTML, so it is reported here instead of being left to look broken.
 */
export function checkContainerOpenings(
  uses: ComponentUse[],
  source: string
): RawIssue[] {
  const starts = lineStarts(source);
  return uses
    .filter((use) => CONTAINER_NAMES.includes(use.spec.tag))
    .flatMap((use) => containerOpeningIssues(use, source, starts));
}

/** `provenance` closes the article: nothing but comments may follow it. */
export function checkProvenanceLast(
  uses: ComponentUse[],
  source: string
): RawIssue[] {
  const provenance = uses.find((use) => use.spec.tag === "provenance");
  const end = provenance && endOf(provenance);
  if (!(provenance && end)) {
    return [];
  }
  if (source.slice(end.end).replace(COMMENT_RE, "").trim() === "") {
    return [];
  }
  return [
    issueAt(
      provenance.open,
      "provenance-not-last",
      "<provenance> must be the last block of the article."
    ),
  ];
}
