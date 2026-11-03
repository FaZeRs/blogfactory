import { extractMainText } from "../../services/internal-linking.js";
import { safeFetch as defaultSafeFetch, validatePublicUrl } from "../../services/safe-fetch.js";

export const MAX_PAGE_BYTES = 2_000_000;
export const MAX_PAGE_CHARS = 200_000;
const READ_TIMEOUT_MS = 30_000;
const CRAWL_TIMEOUT_MS = 90_000;

export type ReadPage = {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  markdown: string;
  fetchedVia: "crawl4ai" | "safe-fetch";
  fetchedAt: Date;
};
export type PageReader = { read(url: string, signal?: AbortSignal): Promise<ReadPage> };

type Env = Record<string, string | undefined>;

const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function withTimeout(ms: number, signal?: AbortSignal) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// Stops at the cap instead of buffering an oversized body; null means too large.
async function readCapped(res: Response): Promise<string | null> {
  if (Number(res.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPageReader(
  env: Env,
  deps: { fetchImpl?: typeof fetch; safeFetch?: typeof defaultSafeFetch } = {},
): PageReader {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const safe = deps.safeFetch ?? defaultSafeFetch;
  const crawlBase = env.CRAWL4AI_URL?.trim().replace(/\/+$/, "");

  async function viaCrawl4ai(url: string, signal?: AbortSignal): Promise<ReadPage | null> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (env.CRAWL4AI_TOKEN) headers.authorization = `Bearer ${env.CRAWL4AI_TOKEN}`;
      const res = await fetchImpl(`${crawlBase}/md`, {
        method: "POST",
        headers,
        body: JSON.stringify({ f: "fit", url }),
        signal: withTimeout(CRAWL_TIMEOUT_MS, signal),
      });
      if (!res.ok) return null;
      const text = await readCapped(res);
      if (text === null) return null;
      const markdown = String((JSON.parse(text) as { markdown?: unknown }).markdown ?? "").trim().slice(0, MAX_PAGE_CHARS);
      if (!markdown) return null;
      return { url, finalUrl: url, status: 200, title: markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? null, markdown, fetchedVia: "crawl4ai", fetchedAt: new Date() };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
  }

  async function viaSafeFetch(url: string, signal?: AbortSignal): Promise<ReadPage> {
    // A page we cannot use is data (status, empty markdown), not an error that fails the stage.
    const skipped = (status: number, finalUrl = url, title: string | null = null): ReadPage =>
      ({ url, finalUrl, status, title, markdown: "", fetchedVia: "safe-fetch", fetchedAt: new Date() });
    let res: Response;
    try {
      res = await safe(url, { signal: withTimeout(READ_TIMEOUT_MS, signal), maxResponseBytes: MAX_PAGE_BYTES, headers: { accept: "text/html,text/plain;q=0.9" } });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return skipped(0);
    }
    const finalUrl = res.url || url;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok || (type && !/^(text\/|application\/xhtml)/.test(type))) {
      await res.body?.cancel().catch(() => {});
      return skipped(res.status, finalUrl);
    }
    let html: string | null;
    try {
      html = await readCapped(res);
    } catch {
      return skipped(res.status, finalUrl);
    }
    if (html === null) return skipped(res.status, finalUrl);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return {
      url, finalUrl, status: res.status,
      title: title ? decode(title).replace(/\s+/g, " ").trim() || null : null,
      markdown: extractMainText(html).slice(0, MAX_PAGE_CHARS),
      fetchedVia: "safe-fetch", fetchedAt: new Date(),
    };
  }

  return {
    async read(url, signal) {
      validatePublicUrl(url);
      const crawled = crawlBase ? await viaCrawl4ai(url, signal) : null;
      return crawled ?? viaSafeFetch(url, signal);
    },
  };
}
