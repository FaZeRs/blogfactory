# AI answer visibility: design spec

Date: 2026-11-06. This is sub-project 8 of `2026-11-03-blog-engine-design.md`. The owner asked for it ("I want to keep tracking which AI answers cite Lindevo") and approved it as the next phase. They also said to decide open questions myself, so each decision below gives its reason.

## Goal

Each week, ask AI answer engines the questions a site's customers ask, and record:
- whether each answer cites the site;
- which of the site's pages it cites;
- whether it mentions the brand;
- which other domains it cites instead.

Show the results as a share and a trend on Search Growth, and turn "competitors cited, we're not" into article ideas.

## What Lindevo does today (survey 2026-11-06)

- **Engines:** two, through LiteLLM. Gemini grounded (`tools:[{googleSearch:{}}]`) and OpenAI web search (`/v1/responses` with `tools:[{type:"web_search"}]`).
- **Questions:** 21 fixed questions in code, plus up to 5 weekly radar questions.
- **Detection:** an exact host match only (`lindevo.com`, `www.lindevo.com`). Brand mentions don't count.
- **Not tracked:** competitors, any trend, and any history view.
- **Storage:** `ai_citations` table, one row per engine and question per ISO week. The answer is capped at 8,000 characters.
- **Schedule and caps:** Monday 07:00 Riga, calls made one at a time with pauses between them, and a stop at the monthly engine budget.
- **Lessons kept here:**
  - A question must never name the brand.
  - Keep the list stable so weeks compare.
  - An empty answer is a failure, not "not cited".
  - A quota error stops that engine; a 429 is waited out.
  - Count spend at the call.
  - Normalize URLs before matching.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Engines | **OpenRouter web search**, normalized `url_citation` annotations. Defaults are three engines with native search: `openai/gpt-5.6-luna` (OpenAI, about $0.01 a search), `perplexity/sonar` (Perplexity, $0.005) and `google/gemini-3.5-flash` (Google, $0.014), all called with `plugins:[{id:"web"}]`. Each site can choose engines from OpenRouter's model list, which is checked against live availability. | One provider and one response shape. It uses the user's own key (AGENTS.md: no second provider flow). It covers the assistants people actually use. The exact default ids are resolved against the live model list at runtime and fall back to the closest available model in the same family. |
| Custom gateway (`ENGINE_AI_*`) | **Out of scope for v1.** The engine set needs OpenRouter. When only a custom gateway is configured, the panel says so. | LiteLLM has no common shape for grounding; Lindevo needed hand-written adapters for each engine. |
| Detection | Two signals, stored separately: **cited** (any cited URL whose host is the site domain or a subdomain of it, after normalization) and **mentioned** (the brand name or domain appears in the answer text, word-bounded and case-insensitive). The headline metric is *cited*; *mentioned* is shown beside it. | A citation sends traffic, while a mention only builds awareness. Lindevo only tracked citations. |
| Competitors | Every other cited host is stored. Hosts in the site's `competitors` list (idea settings) are flagged. The panel ranks the domains cited most often. | The owner wants to know who is winning those answers. |
| Questions | A **per-site list** (5–30), editable in Search Growth. Suggestions come from Search Console queries phrased as questions, idea audience questions and seed topics. One model call drafts the questions and the owner keeps the ones they want. A question may not contain the brand name or domain; this is validated. | Stable and owner-controlled, as in Lindevo, but not hard-coded. |
| Schedule | Weekly, on a per-site weekday (default Monday), run by an hourly worker task. A run covers each engine for each question, once per ISO week, enforced by a unique index on (site, week, engine, question hash). There is also a **Run now** button. | It matches Lindevo's cadence and is idempotent across worker restarts. |
| Calls | Run one at a time per site, with a 2-second pause between calls (OpenRouter rate limits). A 429 is waited out up to 90 seconds, at most twice. A quota or billing error stops that engine for the run. An empty answer counts as a failure. | These are Lindevo's lessons. |
| Cost | Logged to `generation_logs` per call (`usageType: "text"`, `responseData.aiVisibility`), so account guardrails and Usage see it. There is a per-site monthly cap (default $15); the run is skipped when the next run's estimate would exceed it. Measured: about $0.04 (OpenAI), $0.015 (Perplexity) and $0.05–0.13 (Google, which runs 2–6 paid searches) per question, so 21 questions cost about $2.50 a week. | No surprise spend. |
| Storage | The answer text is capped at 4,000 characters and never enters the ledger. It is kept, so the owner can read what the engine said. | Evidence without bloat. |
| History import | A CLI, `npm run import:lindevo-citations -- --site <id> --source-url <lindevo db url>`, reads `content_engine.ai_citations` read-only and maps rows to the new table. It is idempotent through the unique index. | The owner asked to keep the history. A CLI avoids putting a second database credential into the app. |
| Ideas link | Questions where a competitor is cited and the site isn't, for two weeks running, feed discovery as `ai_gap` signals. The panel has an **Add as idea** button on each such question. | This was planned in the program spec. |
| MCP | One read-only tool, **`get_ai_visibility`** (`content:read`, site-scoped), which returns the latest summary, the trend and the gap questions. The catalog goes from 26 to 27. | Agents can report on visibility, but can't spend money or change settings. |

## Data (migration `0043_ai_visibility.sql`)

### `ai_answer_checks`

- `id`, `user_id`, `site_id`
- `week` (text, ISO week such as `2026-W45`)
- `question`, `question_hash` (sha256 of the normalized question)
- `engine` (the model id used), `engine_label` (`OpenAI`, `Perplexity`, `Google`, …)
- `status`: `ok` or `failed`; `error` holds a short reason
- `answer` (capped at 4,000 characters)
- `cited` (boolean), `cited_urls` (text[], the site's own pages), `mentioned` (boolean)
- `other_hosts` (text[], other cited hosts, deduped), `competitor_hosts` (text[], the subset found in the competitors list)
- `cost_usd`, `asked_at`

Indexes: a unique index on `(site_id, week, engine, question_hash)`, and `(user_id, site_id, week)`.

### Settings

`user_settings.ai_visibility` (jsonb) is stored per site:
- `enabled` (default false until questions exist)
- `questions` (string[])
- `engines` (string[] of model ids)
- `weekday` (0–6, default 1)
- `monthlyCapUsd` (default 15)
- `brandTerms` (string[], defaulting to the site name and domain; used for mention detection and question validation)

## Services (`server/src/services/ai-visibility/`)

- **`engines.ts`:**
  - `askEngine({apiKey, model, question, signal})` calls `POST https://openrouter.ai/api/v1/chat/completions` with `{model, messages:[{role:"user", content: question}], plugins:[{id:"web"}]}`. The `:online` suffix is not used, because the plugin is equivalent and keeps the model ids clean.
  - It returns `{answer, citations: [{url,title}], costUsd, model}`.
  - It throws typed errors: `RateLimitError` (with `retryAfterMs`), `QuotaError` and `EmptyAnswerError`.
  - The cost comes from `usage.cost`, with a fallback to an estimate.
- **`detect.ts`** (pure functions):
  - `normalizeUrl`: http(s) only; strips the hash, credentials and tracking parameters; trims the trailing slash.
  - `siteHostMatch(host, domain)`: an exact match or a subdomain match. `evil.example/lindevo.com` and `lindevo.com.evil.example` don't count.
  - `classify({answer, citations, domain, brandTerms, competitors})` returns `{cited, citedUrls, mentioned, otherHosts, competitorHosts}`.
- **`questions.ts`:**
  - `validateQuestions` requires 5–200 characters, a trailing "?", no brand term, deduping, and at most 30 questions.
  - `suggestQuestions(userId, siteId)` makes one model call over Search Console queries, idea audience questions and seed topics, and returns up to 20 suggestions.
- **`run.ts`:**
  - `runVisibility(userId, siteId, {week?, force?})` checks the account guardrails and the monthly cap, then goes through questions × engines that have no row for the week.
  - It inserts each result as soon as it arrives, logs the spend, and writes one sanitized operation event per run (counts and cost only).
  - `drainVisibility(now)` runs every enabled site whose weekday has arrived and whose current week is incomplete. It is bounded and isolates failures, and the worker runs it hourly.
- **`summary.ts`:** `visibilitySummary(userId, siteId)` returns:
  - **Latest week:** `{questions, answered, citedQuestions (cited by at least one engine), share, mentionedShare}` and, per engine, `{asked, cited, share}`.
  - **`trend`:** the last 12 weeks of `{week, share}`.
  - **`topCompetitors`:** `[{host, count, flagged}]`, the top 10.
  - **`gaps`:** questions cited for a competitor but not the site in the latest week, with the competitor hosts and a flag for whether it held two weeks running.
  - **`checks`:** the latest week's rows, for drill-down.
  - **`costThisMonth`.**
- **Ideas:** a `aiGapSignals(userId, siteId)` collector adds `ai_gap` signals to idea discovery (source `ai_gap`). "Add as idea" calls the existing manual-idea service, with the question as the title.

## API

- `GET /api/ai-visibility?siteId` returns the summary, the settings and an availability flag (needs an OpenRouter key).
- `PUT /api/ai-visibility/settings` takes `{siteId, settings}` and validates the questions and engines.
- `POST /api/ai-visibility/suggest` takes `{siteId}` and returns `{questions}`.
- `POST /api/ai-visibility/run` takes `{siteId}` and starts a run on the worker. It returns 202, plus a running status that the panel polls.
- `GET /api/ai-visibility/models` returns the engine choices available on OpenRouter.

## Web

On Search Growth (`/overview/growth`), a **Cited in AI answers** panel shows:
- the headline share of questions cited this week, with the mentioned share and a 12-week trend sparkline;
- a small table per engine;
- the top competitor domains;
- a Gaps list, with **Add as idea** on each;
- a drill-down to each question, showing per engine: cited or not, the cited pages, the competitors and the answer (collapsed);
- **Run now**, **Edit questions** (a dialog with suggestions and validation), engine choice, weekday and monthly cap.

Overview gets one number: "Cited in AI answers: X% this week".

## Testing

- **Pure functions:** `detect` (including the host tricks, tracking parameters, brand word boundaries and subdomains) and `validateQuestions`.
- **`askEngine`** against a fake fetch: the citation parsing, 429 handling, quota errors and empty answers.
- **`runVisibility`** against the test DB with a fake engine: idempotency per week, the monthly cap, guardrails and spend logging.
- **`summary`:** shares, trend, gaps and the two-week rule.
- **Routes:** tenant checks.
- **MCP:** the catalog of 27 tools and the tool's scope.
- **Web:** panel rendering and the Edit questions flow.
- **Real run on the dev server:** run it for lindevo.com with Lindevo's questions and check the numbers and the drill-down.
