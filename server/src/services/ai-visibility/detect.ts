// Pure URL, host and brand matching for AI answer checks.

const TRACKING_PARAMS = /^(utm_[a-z0-9_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|igshid|yclid|_ga|_gl)$/i;

/** http(s) only; no hash, credentials or tracking parameters; no trailing slash. Null when it is not a web URL. */
export function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  const out = url.toString();
  return out.endsWith("/") ? out.slice(0, -1) : out.replace(/\/(\?|$)/, "$1");
}

/** Lowercased host without `www.`; null for anything that is not a web URL. */
export function hostOf(raw: unknown): string | null {
  const url = normalizeUrl(raw);
  if (!url) return null;
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") || null;
}

/** The site's own domain or one of its subdomains; `lindevo.com.evil.example` is not a match. */
export function siteHostMatch(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  return !!d && (h === d || h.endsWith(`.${d}`));
}

/** Brand terms found in the answer, word-bounded and case-insensitive. Terms under 3 characters are ignored. */
export function mentions(answer: string, brandTerms: string[]): boolean {
  return brandTerms.some((term) => {
    const t = term.trim();
    if (t.length < 3) return false;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(answer);
  });
}

export type Classification = {
  cited: boolean;
  citedUrls: string[];
  mentioned: boolean;
  otherHosts: string[];
  competitorHosts: string[];
};

export function classify(input: {
  answer: string;
  citations: { url: string; title?: string }[];
  domain: string;
  brandTerms: string[];
  competitors: string[];
}): Classification {
  const citedUrls = new Set<string>();
  const others = new Set<string>();
  for (const c of input.citations) {
    const url = normalizeUrl(c.url);
    const host = hostOf(c.url);
    if (!url || !host) continue;
    if (siteHostMatch(host, input.domain)) citedUrls.add(url);
    else others.add(host);
  }
  const otherHosts = [...others];
  return {
    cited: citedUrls.size > 0,
    citedUrls: [...citedUrls],
    mentioned: mentions(input.answer, input.brandTerms),
    otherHosts,
    competitorHosts: otherHosts.filter((h) => input.competitors.some((c) => siteHostMatch(h, c))),
  };
}
