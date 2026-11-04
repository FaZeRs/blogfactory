import { createHash } from "node:crypto";

const HIGH_SURROGATE_FROM = 0xd8_00;
const HIGH_SURROGATE_TO = 0xdb_ff;
const LOW_SURROGATE_FROM = 0xdc_00;
const LOW_SURROGATE_TO = 0xdf_ff;
const NUL = String.fromCharCode(0);
// A surrogate half with no partner: a high one not followed by a low one, or a low one not
// preceded by a high one. Postgres text and jsonb reject them, and so do JSON APIs.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xff_fd);

/** True when cutting `text` at `end` would separate the two halves of one character. */
function splitsSurrogatePair(text: string, end: number): boolean {
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  return (
    before >= HIGH_SURROGATE_FROM &&
    before <= HIGH_SURROGATE_TO &&
    after >= LOW_SURROGATE_FROM &&
    after <= LOW_SURROGATE_TO
  );
}

/**
 * Never longer than `max`: a budget below one character yields an empty string. The cut never
 * falls between the halves of a surrogate pair (an emoji): the whole character is dropped, so a
 * well-formed text stays well-formed. Text that already holds a lone half keeps it; see
 * `sanitizeText`.
 */
export function truncate(text: string, max: number): string {
  if (max < 1) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  if (end > 0 && splitsSurrogatePair(text, end)) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/**
 * Text that is about to be stored or sent: U+0000 removed (Postgres text and jsonb cannot hold it)
 * and every lone surrogate half replaced by U+FFFD (what `String.prototype.toWellFormed` does; the
 * project's `lib` predates it). Whole pairs and everything else are kept.
 */
export function sanitizeText(text: string): string {
  const clean = text.includes(NUL) ? text.replaceAll(NUL, "") : text;
  return clean.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight and returns the results in input order.
 * After the first rejection no new item is started (in-flight calls finish, their results are
 * dropped), so model calls and spend do not continue behind a promise that already rejected.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (Number.isNaN(limit) || limit < 1) {
    throw new RangeError(`mapLimit: limit must be at least 1, got ${limit}`);
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}


export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A page heading that belongs to the site's chrome (a cookie banner, a login wall, a bot check), not to the article. */
const CHROME_RE =
  /cookies?|privacy|consent|sign[\s-]?in|log[\s-]?in|subscribe|newsletter|access denied|just a moment|page not found|404|enable javascript|are you a robot|captcha/i;
const TRAILING_PUNCT_RE = /[\s:.\-–—]+$/u;
const URL_RE = /https?:|www\./i;
/** A section word that names no page. */
const GENERIC = new Set([
  "contents",
  "history",
  "home",
  "introduction",
  "menu",
  "navigation",
  "overview",
  "references",
  "see also",
  "summary",
]);

/**
 * Whether a source title is boilerplate a crawl picked up (the first heading of a page is often a cookie
 * banner or a nav label), so it must not be shown as the name of the source.
 */
export function isBoilerplateTitle(title: string): boolean {
  const text = title.trim();
  return (
    CHROME_RE.test(text) ||
    URL_RE.test(text) ||
    GENERIC.has(text.toLowerCase().replace(TRAILING_PUNCT_RE, ""))
  );
}

/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;

const WHITESPACE_RUN = /\s+/;

export function wordCount(text: string): number {
  return text.split(WHITESPACE_RUN).filter(Boolean).length;
}
