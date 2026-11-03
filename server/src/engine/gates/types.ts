export interface GateIssue {
  excerpt?: string;
  hint?: string;
  message: string;
}

export interface GateResult {
  gate: string;
  issues: GateIssue[];
  metrics?: Record<string, number>;
  passed: boolean;
  severity: "blocker" | "warning";
}

export interface EvidenceItem {
  claim: string;
  id: string;
  quote: string;
  sourceId: string;
  verified: boolean;
}

export interface SourceItem {
  finalUrl: string;
  id: string;
  markdown: string;
  title: string | null;
  url: string;
}

/** What the code gates read. `markdown` is the rendered article, `raw` the draft with its `{{c:id}}` markers. */
export interface GateInput {
  description: string;
  evidence: EvidenceItem[];
  existingPosts: { content: string; id: string; title: string }[];
  markdown: string;
  raw: string;
  siteUrl: string;
  sources: SourceItem[];
  title: string;
}

export function gateResult(
  gate: string,
  issues: GateIssue[],
  severity: "blocker" | "warning" = "blocker",
  metrics?: Record<string, number>
): GateResult {
  return {
    gate,
    issues,
    ...(metrics === undefined ? {} : { metrics }),
    passed: issues.length === 0,
    severity,
  };
}

/** One blocker per issue of every failed blocker-severity gate. Warnings never become blockers. */
export function gateBlockers(
  results: GateResult[]
): { excerpt?: string; fix?: string; gate: string; message: string }[] {
  return results
    .filter((r) => !r.passed && r.severity === "blocker")
    .flatMap((r) =>
      r.issues.map((i) => ({
        excerpt: i.excerpt,
        fix: i.hint,
        gate: r.gate,
        message: i.message,
      }))
    );
}
