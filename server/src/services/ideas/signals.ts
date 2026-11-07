import type { SearchClient } from "../../engine/adapters/search.js";
import type { DataForSeoClient } from "../../engine/adapters/types.js";
import { sanitizeText, truncate } from "../../engine/util.js";
import { tokens } from "./novelty.js";
import type { IdeaSources } from "./settings.js";

export const SIGNAL_SOURCES = ["gsc", "news", "keywords", "paa", "rss", "competitor", "ai_gap", "feed", "hn", "reddit", "page"] as const;
export type SignalSource = typeof SIGNAL_SOURCES[number];
export type Signal = {
  id: string;
  source: SignalSource;
  title: string;
  summary: string;
  url?: string;
  publishedAt?: string;
  metric?: Record<string, number | string | null>;
};
type RawSignal = Omit<Signal, "id">;

export const MAX_SIGNALS = 150;
export const COLLECTOR_TIMEOUT_MS = 20_000;
const FRESH_DAYS = 30;

export type GscQueryRow = { query: string; impressions: number; clicks: number; position: number };
export type FeedItem = { title: string; url?: string; pubDate?: string };

export type CollectorDeps = {
  now: () => Date;
  locale: string;
  seeds: string[];
  competitors: string[];
  search: SearchClient;
  dataForSeo: DataForSeoClient | null;
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>;
  fetchFeed: (url: string, limit: number, days: number) => Promise<FeedItem[]>;
  gscQueries: () => Promise<GscQueryRow[]>;
  feedUrls: () => Promise<string[]>;
  /** The owner's idea sources; absent means none. */
  sources?: IdeaSources;
  /** A JSON GET that does not throw on an HTTP error status; the body is null when it is not JSON. */
  fetchJson?: (url: string, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
  /** Receives a watched page's links after a successful read; discovery saves them as the next baseline. */
  recordSeen?: (pageUrl: string, links: string[]) => void;
  /** AI-answer gaps the site could fill; absent means the source is skipped. */
  aiGaps?: () => Promise<{ question: string; competitorHosts: string[]; otherHosts: string[] }[]>;
};

const clean = (t: string | null | undefined, max: number) => truncate(sanitizeText(t ?? "").replace(/\s+/g, " ").trim(), max);

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Forward-only `<url>` scan: `{loc, lastmod}` entries, or `<sitemap>` children for an index. A missing close tag stops the scan. */
export function parseSitemap(xml: string, max = 2000): { index: boolean; entries: { loc: string; lastmod?: string }[] } {
  const index = /<sitemapindex[\s>]/i.test(xml.slice(0, 4096));
  const open = index ? "<sitemap>" : "<url>";
  const close = index ? "</sitemap>" : "</url>";
  const entries: { loc: string; lastmod?: string }[] = [];
  let pos = 0;
  while (entries.length < max) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    const block = xml.slice(start, end);
    const tag = (name: string) => block.match(new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([^<]*?)(?:\\]\\]>)?\\s*</${name}>`))?.[1]?.trim();
    const loc = tag("loc");
    if (loc) entries.push({ loc, lastmod: tag("lastmod") });
    pos = end + close.length;
  }
  return { index, entries };
}

const slugTitle = (url: string) => {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return seg.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").trim();
  } catch { return ""; }
};

const daysAgo = (iso: string | undefined, now: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null;
};

export const SEEN_LINKS_LIMIT = 300;
const MAX_NEW_PAGE_LINKS = 15;
const MAX_PAGE_SCAN = 5_000_000;

/** Same-host `<a href>` links of a page whose URL contains `pattern` (a plain substring, case-insensitive), with their text. Forward scan: an unclosed tag stops it. */
export function extractLinks(html: string, pageUrl: string, pattern?: string): { url: string; text: string }[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, "").toLowerCase();
  const needle = pattern?.toLowerCase();
  const out = new Map<string, string>();
  const open = /<a\s/gi;
  const text = html.slice(0, MAX_PAGE_SCAN);
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const tagEnd = text.indexOf(">", m.index);
    const close = tagEnd === -1 ? -1 : text.indexOf("</a>", tagEnd);
    if (close === -1) break;
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text.slice(m.index, tagEnd))?.slice(1).find((v) => v !== undefined);
    if (!href) continue;
    let url: URL;
    try { url = new URL(href.replace(/&amp;/g, "&"), base); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const abs = url.toString();
    if (abs.length > 500) continue; // stored seen links are capped at 500 characters, so a longer one would read as new every run
    if (url.hostname.replace(/^www\./, "").toLowerCase() !== host || abs.replace(/\/$/, "") === base.toString().replace(/\/$/, "").replace(/#.*$/, "")) continue;
    if (needle && !abs.toLowerCase().includes(needle)) continue;
    const label = text.slice(tagEnd + 1, close).replace(/<[^>]*>/g, " ");
    if (!out.has(abs)) out.set(abs, label);
  }
  return [...out].map(([url, label]) => ({ url, text: label }));
}

/** First run (no baseline) emits nothing; later runs emit links not in the baseline. The new baseline lists current links first, capped. */
export function diffLinks(all: { url: string; text: string }[], seen: string[] | undefined): { fresh: { url: string; text: string }[]; baseline: string[] } {
  // Only the first links fit the baseline; links past the cap would otherwise read as new on every run.
  const links = all.slice(0, SEEN_LINKS_LIMIT);
  const known = new Set(seen ?? []);
  const baseline = [...new Set([...links.map((l) => l.url), ...(seen ?? [])])].slice(0, SEEN_LINKS_LIMIT);
  return { fresh: seen ? links.filter((l) => !known.has(l.url)) : [], baseline };
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseHnHits(body: unknown, query: string, minPoints: number, now: Date): RawSignal[] {
  const out: RawSignal[] = [];
  for (const h of list(obj(body).hits).slice(0, 10)) {
    const hit = obj(h);
    const title = typeof hit.title === "string" ? hit.title : "";
    const created = typeof hit.created_at === "string" ? hit.created_at : undefined;
    const age = daysAgo(created, now);
    if (!title || num(hit.points) < minPoints || (age !== null && age > FRESH_DAYS)) continue;
    const id = typeof hit.objectID === "string" ? hit.objectID : "";
    const url = typeof hit.url === "string" && hit.url ? hit.url : id ? `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}` : undefined;
    out.push({
      source: "hn", title: clean(title, 200), url, publishedAt: created,
      summary: `Hacker News: ${num(hit.points)} points, ${num(hit.num_comments)} comments (search "${clean(query, 80)}")`,
      metric: { points: num(hit.points), comments: num(hit.num_comments) },
    });
  }
  return out;
}

export function parseRedditPosts(body: unknown, subreddit: string, now: Date): RawSignal[] {
  const out: RawSignal[] = [];
  for (const c of list(obj(obj(body).data).children).slice(0, 10)) {
    const post = obj(obj(c).data);
    const title = typeof post.title === "string" ? post.title : "";
    const created = num(post.created_utc) ? new Date(num(post.created_utc) * 1000).toISOString() : undefined;
    const age = daysAgo(created, now);
    if (!title || post.stickied === true || post.over_18 === true || (age !== null && age > FRESH_DAYS)) continue;
    const permalink = typeof post.permalink === "string" && post.permalink.startsWith("/") ? `https://www.reddit.com${post.permalink}` : undefined;
    out.push({
      source: "reddit", title: clean(title, 200), url: permalink, publishedAt: created,
      summary: `r/${subreddit}: ${num(post.score)} upvotes, ${num(post.num_comments)} comments this week`,
      metric: { score: num(post.score), comments: num(post.num_comments) },
    });
  }
  return out;
}

type Collector = (d: CollectorDeps, signal: AbortSignal) => Promise<RawSignal[]>;

const collectors: Record<SignalSource, Collector> = {
  async gsc(d) {
    return (await d.gscQueries()).slice(0, 40).map((r) => ({
      source: "gsc" as const,
      title: clean(r.query, 160),
      summary: `Search Console: ${r.impressions} impressions, average position ${r.position.toFixed(1)}, ${r.clicks} clicks`,
      metric: { impressions: r.impressions, position: Math.round(r.position * 10) / 10, clicks: r.clicks },
    }));
  },

  async news(d, signal) {
    if (d.search.name !== "searxng") return []; // only SearXNG can filter to news
    const out: RawSignal[] = [];
    for (const seed of d.seeds.slice(0, 5)) {
      signal.throwIfAborted();
      const hits = await d.search.search(seed, { locale: d.locale, limit: 6, signal, news: true }).catch((e) => { if (signal.aborted) throw e; return []; });
      for (const h of hits) out.push({ source: "news", title: clean(h.title, 200), summary: clean(h.snippet, 300), url: h.url });
    }
    return out;
  },

  async keywords(d, signal) {
    if (!d.dataForSeo || !d.seeds.length) return [];
    const ideas = await d.dataForSeo.keywordIdeas(d.seeds.slice(0, 5), { locale: d.locale, limit: 40, signal });
    return ideas
      .filter((k) => (k.volume ?? 0) > 0)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 30)
      .map((k) => ({
        source: "keywords" as const,
        title: clean(k.keyword, 160),
        summary: `Keyword data: volume ${k.volume}${k.difficulty != null ? `, difficulty ${k.difficulty}` : ""}${k.intent ? `, ${k.intent} intent` : ""}`,
        metric: { volume: k.volume, difficulty: k.difficulty, intent: k.intent },
      }));
  },

  async paa(d, signal) {
    if (!d.dataForSeo) return [];
    const out: RawSignal[] = [];
    for (const seed of d.seeds.slice(0, 3)) {
      signal.throwIfAborted();
      for (const q of await d.dataForSeo.peopleAlsoAsk(seed, { locale: d.locale })) {
        out.push({ source: "paa", title: clean(q, 200), summary: `People also ask about "${clean(seed, 80)}"` });
      }
    }
    return out;
  },

  async rss(d, signal) {
    const out: RawSignal[] = [];
    for (const url of (await d.feedUrls()).slice(0, 8)) {
      signal.throwIfAborted();
      const items = await d.fetchFeed(url, 8, FRESH_DAYS).catch((e) => { if (signal.aborted) throw e; return []; });
      for (const i of items) out.push({ source: "rss", title: clean(i.title, 200), summary: "Item from a feed configured for this site", url: i.url, publishedAt: i.pubDate });
    }
    return out;
  },

  async feed(d, signal) {
    const feeds = (d.sources?.feeds ?? []).slice(0, 20);
    let failure = "";
    let failed = 0;
    const groups = await Promise.all(feeds.map(async (url) => {
      const items = await d.fetchFeed(url, 8, FRESH_DAYS).catch((e) => {
        if (signal.aborted) throw e;
        failed += 1;
        failure ||= `${hostOf(url)}: ${(e as Error)?.message ?? "failed"}`;
        return [];
      });
      return items.slice(0, 8).map((i) => ({ source: "feed" as const, title: clean(i.title, 200), summary: `Item from an idea feed (${hostOf(url)})`, url: i.url, publishedAt: i.pubDate }));
    }));
    if (feeds.length && failed === feeds.length) throw new Error(failure);
    return groups.flat();
  },

  async hn(d, signal) {
    const queries = d.sources?.hn.queries ?? [];
    if (!queries.length || !d.fetchJson) return [];
    const since = Math.floor((d.now().getTime() - FRESH_DAYS * 86_400_000) / 1000);
    const out: RawSignal[] = [];
    let failed = 0;
    for (const q of queries.slice(0, 10)) {
      signal.throwIfAborted();
      try {
        const filters = encodeURIComponent(`points>=${d.sources!.hn.minPoints},created_at_i>${since}`);
        const res = await d.fetchJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=${filters}&hitsPerPage=10`, signal);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        out.push(...parseHnHits(res.body, q, d.sources!.hn.minPoints, d.now()));
      } catch (e) {
        if (signal.aborted) throw e;
        failed += 1;
        if (failed === queries.length) throw e;
      }
    }
    return out;
  },

  async reddit(d, signal) {
    const out: RawSignal[] = [];
    let failure = "";
    for (const name of (d.sources?.subreddits ?? []).slice(0, 10)) {
      if (!d.fetchJson) break;
      signal.throwIfAborted();
      try {
        const res = await d.fetchJson(`https://www.reddit.com/r/${encodeURIComponent(name)}/top.json?t=week&limit=10`, signal);
        // Reddit answers 429 (or 403) fast when it wants fewer requests: stop asking this run, keep what we have.
        if (res.status === 429 || res.status === 403) { failure = `Reddit refused (HTTP ${res.status})`; break; }
        if (res.status === 200) out.push(...parseRedditPosts(res.body, name, d.now()));
        else failure ||= `r/${name}: HTTP ${res.status}`;
      } catch (e) {
        if (signal.aborted) throw e;
        failure ||= `r/${name}: ${(e as Error)?.message ?? "failed"}`;
      }
    }
    // Nothing collected and something failed: report it, so the owner sees why the source is empty.
    if (!out.length && failure) throw new Error(failure);
    return out;
  },

  async page(d, signal) {
    const out: RawSignal[] = [];
    const baselines: [string, string[]][] = [];
    let failed = 0;
    let failure = "";
    const pages = (d.sources?.pages ?? []).slice(0, 10);
    // In parallel: ten sequential page reads would outlast the collector timeout.
    await Promise.all(pages.map(async (page) => {
      try {
        const links = extractLinks(await d.fetchText(page.url, signal), page.url, page.pattern);
        if (!links.length) return; // a layout change must not wipe the baseline
        const { fresh, baseline } = diffLinks(links, d.sources!.seen[page.url]);
        baselines.push([page.url, baseline]);
        for (const l of fresh.slice(0, MAX_NEW_PAGE_LINKS)) {
          out.push({ source: "page", title: clean(l.text.trim().length >= 3 ? l.text : slugTitle(l.url), 200), summary: `New link on a watched page (${hostOf(page.url)})`, url: l.url });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        failed += 1;
        failure ||= `${hostOf(page.url)}: ${(e as Error)?.message ?? "failed"}`;
      }
    }));
    // Baselines move only when these signals are returned; a timed-out run must not mark its new links as seen.
    signal.throwIfAborted();
    for (const [url, baseline] of baselines) d.recordSeen?.(url, baseline);
    if (pages.length && failed === pages.length) throw new Error(failure);
    return out;
  },

  async competitor(d, signal) {
    const out: RawSignal[] = [];
    for (const raw of d.competitors.slice(0, 5)) {
      signal.throwIfAborted();
      const host = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      if (!host) continue;
      try {
        let { index, entries } = parseSitemap(await d.fetchText(`https://${host}/sitemap.xml`, signal));
        if (index) {
          const children = entries.slice(0, 2);
          entries = [];
          for (const c of children) entries.push(...parseSitemap(await d.fetchText(c.loc, signal)).entries);
        }
        const fresh = entries
          .filter((e) => { const age = daysAgo(e.lastmod, d.now()); return age !== null && age >= 0 && age <= FRESH_DAYS; })
          .sort((a, b) => Date.parse(b.lastmod!) - Date.parse(a.lastmod!))
          .slice(0, 15);
        for (const e of fresh) {
          const title = slugTitle(e.loc);
          if (tokens(title).length >= 2) out.push({ source: "competitor", title: clean(title, 160), summary: `New page on ${host}`, url: e.loc, publishedAt: e.lastmod });
        }
      } catch (e) {
        if (signal.aborted) throw e;
      }
    }
    return out;
  },

  async ai_gap(d) {
    return ((await d.aiGaps?.()) ?? []).slice(0, 20).map((g) => {
      const hosts = [...g.competitorHosts, ...g.otherHosts].slice(0, 5);
      return {
        source: "ai_gap" as const,
        title: clean(g.question, 200),
        summary: `AI answer gap: AI assistants answered without citing this site${hosts.length ? `; they cited ${hosts.join(", ")}` : ""}`,
      };
    });
  },
};

export type CollectorReport = { source: SignalSource; count: number; error?: string };

/** Each collector gets its own time limit; a failure is recorded and the others continue. */
export async function collectSignals(d: CollectorDeps, timeoutMs = COLLECTOR_TIMEOUT_MS): Promise<{ signals: Signal[]; reports: CollectorReport[] }> {
  const settled = await Promise.all(SIGNAL_SOURCES.map(async (source) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timed out")), timeoutMs);
    try {
      const raw = await Promise.race([
        collectors[source](d, ctl.signal),
        new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true })),
      ]);
      // Feeds and sitemaps are third-party: only http(s) URLs may reach the brief, where the web renders them as links.
      return { source, raw: raw.filter((s) => s.title).map((s) => (s.url && !/^https?:\/\//i.test(s.url) ? { ...s, url: undefined } : s)) };
    } catch (error) {
      return { source, raw: [] as RawSignal[], error: error instanceof Error ? error.message.slice(0, 120) : "failed" };
    } finally {
      clearTimeout(timer);
    }
  }));
  return {
    signals: mergeSignals(settled.map((s) => s.raw.map((r) => ({ ...r, source: s.source })))),
    reports: settled.map((s) => ({ source: s.source, count: s.raw.length, ...(s.error ? { error: s.error } : {}) })),
  };
}

/** Dedupes by normalized URL and title, caps at 150 taking round-robin across sources, and assigns ids s1, s2... */
export function mergeSignals(groups: RawSignal[][], cap = MAX_SIGNALS): Signal[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const queues = groups.map((g) => g.filter((s) => {
    const t = tokens(s.title).join(" ");
    const u = s.url ? normalizeUrl(s.url) : "";
    if ((u && seenUrl.has(u)) || (t && seenTitle.has(t))) return false;
    if (u) seenUrl.add(u);
    if (t) seenTitle.add(t);
    return true;
  }));
  const out: Signal[] = [];
  for (let i = 0; out.length < cap && queues.some((q) => i < q.length); i += 1) {
    for (const q of queues) if (i < q.length && out.length < cap) out.push({ ...q[i], id: `s${out.length + 1}` });
  }
  return out;
}

export const signalAgeDays = (s: Signal, now: Date) => Math.max(0, daysAgo(s.publishedAt, now) ?? 7);
