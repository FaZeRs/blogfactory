import { citationDestination, citedUrl, extractMarkerIds } from "../citations.js";
import {
  type EvidenceItem,
  type GateIssue,
  type GateResult,
  type SourceItem,
  gateResult,
} from "./types.js";

const UNRESOLVED_RE = /\{\{c:[^}]*\}\}/;
const MIN_CITED_SOURCES = 3;

/**
 * Every `{{c:id}}` marker in the raw draft names a verified evidence row, none is left unresolved in
 * the published markdown, the published markdown links each cited source (with the destination
 * `renderCitations` writes), and the article cites at least three distinct verified sources.
 * Inline citations are `[host](url)` links, so the link check serves both styles.
 */
export function citationsGate(input: {
  raw: string;
  markdown: string;
  evidence: EvidenceItem[];
  sources: SourceItem[];
}): GateResult {
  const issues: GateIssue[] = [];
  const left = UNRESOLVED_RE.exec(input.markdown);
  if (left) {
    issues.push({
      excerpt: left[0],
      hint: "use only verified claim ids",
      message: "unresolved citation markers remain in the article",
    });
  }
  const byId = new Map(input.evidence.map((e) => [e.id, e]));
  const ids = extractMarkerIds(input.raw);
  const urls = new Set<string>();
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      issues.push({ message: `marker {{c:${id}}} has no evidence row` });
    } else if (e.verified) {
      urls.add(citedUrl(e, input.sources));
    } else {
      issues.push({
        message: `marker {{c:${id}}} points at an unverified claim`,
      });
    }
  }
  for (const url of urls) {
    const destination = citationDestination(url);
    if (destination !== null && !input.markdown.includes(`](${destination})`)) {
      issues.push({
        excerpt: url,
        message: `the article does not link its cited source ${url}`,
      });
    }
  }
  if (urls.size < MIN_CITED_SOURCES) {
    issues.push({
      message: `cites ${urls.size} distinct verified sources; needs ${MIN_CITED_SOURCES}`,
    });
  }
  return gateResult("citations", issues, "blocker", {
    citedSources: urls.size,
    markers: ids.length,
  });
}
