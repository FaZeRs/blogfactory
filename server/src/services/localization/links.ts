import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { postTranslations, posts } from "../../db/schema.js";

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;
/** `](/blog/<slug>` of an inline Markdown link, with what may follow the slug (`#section`, `/`, `)`). */
const BLOG_LINK_RE = /\]\(\/blog\/([a-z0-9-]+)(?=[#/)\s"])/g;

/** Applies `fn` to the markdown between code (fenced blocks and inline spans) and leaves the code as written. */
function mapOutsideCode(md: string, fn: (text: string) => string): string {
  let out = "";
  let at = 0;
  for (const m of md.matchAll(new RegExp(`${FENCE_RE.source}|${CODE_SPAN_RE.source}`, "g"))) {
    out += fn(md.slice(at, m.index)) + m[0];
    at = (m.index ?? 0) + m[0].length;
  }
  return out + fn(md.slice(at));
}

/**
 * Points a link to another English post at its translated edition (`/blog/<en>` to `/<locale>/blog/<translated>`).
 * The translator cannot know the translated slug and keeps the English one. A link to a post with no
 * translation (yet) is left as it is. Code is left as written.
 */
export function localizeBlogLinks(markdown: string, slugs: ReadonlyMap<string, string>, locale: string): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(BLOG_LINK_RE, (whole, slug: string) => {
      const to = slugs.get(slug);
      return to ? `](/${locale}/blog/${to}` : whole;
    }));
}

/** The `/blog/<slug>` links still pointing at the English edition, outside code. */
export function untranslatedBlogLinks(markdown: string): string[] {
  const found: string[] = [];
  mapOutsideCode(markdown, (text) => {
    for (const m of text.matchAll(BLOG_LINK_RE)) found.push(`/blog/${m[1]}`);
    return text;
  });
  return [...new Set(found)];
}

/**
 * English slug to translated slug for the site's posts that have a translation in `locale`. A post's English slug
 * is its SEO metadata slug; a post without one has no entry. Scoped to the user and site.
 */
export async function translatedSlugs(userId: string, siteId: string, locale: string, exceptPostId?: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ en: sql<string | null>`${posts.seoMetadata}->>'slug'`, slug: postTranslations.slug })
    .from(postTranslations)
    .innerJoin(posts, and(eq(posts.id, postTranslations.postId), eq(posts.userId, postTranslations.userId)))
    .where(and(
      eq(postTranslations.userId, userId),
      eq(postTranslations.siteId, siteId),
      eq(postTranslations.locale, locale),
      ne(postTranslations.slug, ""),
      ...(exceptPostId ? [ne(postTranslations.postId, exceptPostId)] : []),
    ));
  return new Map(rows.flatMap((r) => (r.en ? [[r.en, r.slug] as const] : [])));
}
