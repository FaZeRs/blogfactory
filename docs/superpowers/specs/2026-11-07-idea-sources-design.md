# Idea sources (radar): design spec

Date: 2026-11-07. The owner asked for their own idea sources, as in the Lindevo content engine's radar (`apps/content-engine/src/radar`: `feeds.ts`, `collectors/hn.ts`, `collectors/reddit.ts`, `collectors/link-diff.ts`, surveyed 2026-11-07). Idea discovery (`services/ideas/signals.ts`) already collects Search Console, news, keywords, People Also Ask, RSS, competitor sitemaps and AI-answer gaps. Its RSS source reads only the site's active **generation** feeds (Sources → RSS), which also write articles on their own schedule, so a feed can't be added just for ideas.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Where | A new **Idea sources** card in **Ideas → Settings**, stored in the existing `user_settings.ideas` settings (`IdeaSettings.sources`), per site. No migration. | Seed topics and competitors already live there. |
| Shape | `sources: { feeds: string[] (≤20 http(s) URLs), hn: { queries: string[] (≤10, ≤80 chars), minPoints: 0–1000 (default 20) }, subreddits: string[] (≤10 names, `[A-Za-z0-9_]{2,21}`, without "r/"), pages: { url, pattern? }[] (≤10; pattern is a plain substring, not a regex, ≤100 chars) }`. | Bounded and simple. A substring instead of Lindevo's regex avoids user-supplied regex (ReDoS). |
| Signals | Four new signal sources: `feed`, `hn`, `reddit`, `page`, each its own collector with its own timeout and report entry. Items older than 30 days are dropped (as for RSS). | Each source fails on its own and shows its count in the discovery report. |
| Feeds | Idea-only feeds, read with the existing `fetchFeed` (same parser as generation feeds); at most 8 items per feed. The existing `rss` source (generation feeds) stays. | Reuses the hardened parser; idea feeds never generate articles. |
| Hacker News | The public Algolia API `https://hn.algolia.com/api/v1/search_by_date?query=…&tags=story&numericFilters=points>=N,created_at_i>…`, at most 10 hits per query. Summary: points and comments. | No key needed; Lindevo uses the same API. |
| Reddit | `https://www.reddit.com/r/<name>/top.json?t=week&limit=10` with a descriptive User-Agent. A 429 or 403 skips that subreddit and stops asking Reddit for this run (Lindevo's backoff); not fatal. Stickied and NSFW posts are skipped. | Unauthenticated JSON works for low volume. |
| Watched pages | Fetch the page (safe fetch), extract same-host `<a href>` links whose URL contains the pattern (or all same-host links), and keep links not seen in the previous discovery for that page. The first run only records the baseline and emits nothing. Seen links are stored per page (cap 300) in the settings' `sources` state, written by discovery only. At most 15 new links per page. Title is the link text, or the slug as a title. | Lindevo's link-diff: "what's new on this page" for changelogs, docs and news pages without feeds. |
| Security | Every URL goes through `safeFetch` (SSRF guards), with timeouts and response caps. Only http(s) URLs reach the brief (the existing filter). Titles go through `clean` / `sanitizeText`. Nothing from these sources is followed beyond one page. | Third-party input. |
| Cost | No model calls added: the items are signals for the one discovery call that already runs. | |
| Web | The card has four simple lists (feed URLs, HN queries plus minimum points, subreddits, pages with optional pattern) using `InputAffordance` and `url-validation.ts` for URLs, plus the per-source counts and errors in the last-discovery status line. | Existing patterns. |

## Out of scope

- Authenticated Reddit, X/Twitter, YouTube, newsletters by email.
- Regex patterns.
- Using idea feeds for article generation.

## Testing

- **Pure:** settings parsing (bounds, invalid URLs and names dropped), the HN and Reddit response parsing, page link extraction, pattern filtering, and the baseline-then-diff rule.
- **Collectors with fake fetchers:** counts, the 30-day filter, Reddit 429 stopping further Reddit calls, a failing source not affecting others.
- **Discovery self-test:** the new sources' signals reach the candidate call fenced as data, and the reports list them.
- **Web:** the settings card saves and loads.
- **Real:** one discovery for lindevo.com with an idea feed, an HN query, a subreddit and a watched page.
