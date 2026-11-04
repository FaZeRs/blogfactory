import { maskCode } from "../markdown/mask-code.js";
import { type GateIssue, type GateResult, gateResult } from "./types.js";

const H1_RE = /^# /m;
const PROVENANCE_RE = /<provenance\b/;

/** The page's structure: no H1 (the page renders the title) and no `<provenance>` tag (code adds it). */
export function structureGate(markdown: string): GateResult {
  const md = maskCode(markdown);
  const issues: GateIssue[] = [];
  if (PROVENANCE_RE.test(md)) {
    issues.push({
      message:
        "the draft must not contain <provenance>; code adds it from the database",
    });
  }
  if (H1_RE.test(md)) {
    issues.push({
      message: "the body must not contain an H1; the page renders the title",
    });
  }
  return gateResult("structure", issues);
}
