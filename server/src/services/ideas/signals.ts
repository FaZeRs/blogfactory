import type { SearchClient } from "../../engine/adapters/search.js";
import type { DataForSeoClient } from "../../engine/adapters/types.js";
import { sanitizeText, truncate } from "../../engine/util.js";
import { tokens } from "./novelty.js";

export const SIGNAL_SOURCES = ["gsc", "news", "keywords", "paa", "rss", "competitor"] as const;
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
