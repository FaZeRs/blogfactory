import { citationDestination, citedUrl } from "../citations.js";
import { maskCode } from "../markdown/mask-code.js";
import { mapLimit } from "../util.js";
import {
  type GateInput,
  type GateIssue,
  type GateResult,
  gateResult,
} from "./types.js";

/** `[text](href "title")`; the href may hold one level of balanced parentheses (Wikipedia-style). */
const LINK_RE =
  /(?<!!)\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/g;
const HTTP_RE = /^https?:$/;
const EXTERNAL_CONCURRENCY = 4;
/** Only these statuses prove a link is gone. Everything else that is not a success may be a bot wall or a bad moment. */
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);
const ERROR_STATUS = 400;

type Reachability = "ok" | "gone" | "unverified";

/**
 * `checkLink` answers with an HTTP status, or 0 for a failed connection (DNS, refused by the SSRF
 * guard, too many redirects). A timeout should come back as 408.
 * `gone`: 404, 410 or 0. `unverified`: any other error status (401, 403, 405, 408, 429, 5xx ...): bot
 * walls and transient errors are warnings and must not force a revision.
 */
function reachability(status: number): Reachability {
  if (status === 0 || GONE_STATUSES.has(status)) {
    return "gone";
  }
  return status >= ERROR_STATUS ? "unverified" : "ok";
}

const outcome = (status: number) =>
  status === 0 ? "no response" : `status ${status}`;

/** The hrefs of the Markdown links and autolinks outside code, in order, without repeats. */
export function hrefsOf(markdown: string): string[] {
  const md = maskCode(markdown);
  return [
    ...new Set([
      ...[...md.matchAll(LINK_RE)].map((m) => m[2] ?? ""),
      ...[...md.matchAll(AUTOLINK_RE)].map((m) => m[1] ?? ""),
    ]),
  ];
}

/**
 * Every link in the article. Blockers: a malformed link, an unsupported scheme, and a link that is
 * gone (404, 410, or no connection). Warnings (`links-warnings`): the link answered but could not be
 * confirmed (401, 403, 405, 429, 5xx, a timeout). Relative links resolve against `siteUrl`. Every
 * check goes through `checkLink` (the caller's SSRF-guarded client), at most four at a time. A cited
 * source URL is not fetched again.
 */
export async function linksGate(
  input: Pick<GateInput, "evidence" | "markdown" | "siteUrl" | "sources">,
  deps: {
    checkLink: (url: string, signal?: AbortSignal) => Promise<number>;
    signal?: AbortSignal;
  }
): Promise<GateResult[]> {
  const site = new URL(input.siteUrl);
  const cited = new Set<string>();
  for (const e of input.evidence) {
    const url = e.verified ? citedUrl(e, input.sources) : "";
    const destination = citationDestination(url);
    if (destination !== null) {
      cited.add(url);
      cited.add(destination);
    }
  }
  const blockers: GateIssue[] = [];
  const pending: { href: string; url: string }[] = [];
  for (const href of hrefsOf(input.markdown)) {
    let url: URL;
    try {
      url = new URL(href, site);
    } catch {
      blockers.push({ excerpt: href, message: `malformed link ${href}` });
      continue;
    }
    if (!HTTP_RE.test(url.protocol)) {
      blockers.push({
        excerpt: href,
        message: `unsupported link scheme in ${href}`,
      });
    } else if (!(cited.has(href) || cited.has(url.href))) {
      pending.push({ href, url: url.href });
    }
  }
  const warnings: GateIssue[] = [];
  const checked = await mapLimit(pending, EXTERNAL_CONCURRENCY, async (p) => ({
    p,
    status: await deps.checkLink(p.url, deps.signal),
  }));
  for (const { p, status } of checked) {
    const state = reachability(status);
    const issue = {
      excerpt: p.href,
      message: `link ${p.href} returned ${outcome(status)}`,
    };
    if (state === "gone") {
      blockers.push(issue);
    } else if (state === "unverified") {
      warnings.push({
        ...issue,
        hint: "could not be confirmed; check it by hand",
      });
    }
  }
  return [
    gateResult("links", blockers, "blocker", { checked: pending.length }),
    gateResult("links-warnings", warnings, "warning"),
  ];
}
