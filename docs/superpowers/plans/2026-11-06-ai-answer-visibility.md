# AI answer visibility: implementation plan

This plan implements `docs/superpowers/specs/2026-11-06-ai-answer-visibility-design.md`. Read the spec first; it is the source of truth for behaviour. Work on branch `feat/ai-citations`.

## Rules for every task

- Every database query and mutation is scoped to the user (and to the site where relevant).
- Migrations are additive raw SQL in `server/src/db/migrations/`, mirrored in `server/src/db/schema.ts`. Apply them to the dev DB (`npm run db:migrate` from the repo root) and to the test DB. The test DB URL is `server/.env` `DATABASE_URL` with `/blogfactory` replaced by `/blogfactory_engine_test`; set `POSTGRES_INTEGRATION_ALLOW_WRITES=1` and run the same migrate command with that `DATABASE_URL`. Never write tests to `blogfactory`.
- **Tests:**
  - Server code uses `*.self-test.ts`, picked up by `npm run test:server`. See `server/src/services/ideas/*.self-test.ts` for the DB-test pattern (skip when the test DB is not configured). Two tests failed before this work (`routes/auth.self-test.ts`, `services/search-console.self-test.ts`); no new failures are allowed.
  - Web uses vitest with the `createRoot` + `act` pattern; see `web/src/components/posts/CoverPanel.test.tsx`. Testing Library is not installed. Nine web test files failed before this work; no new failures are allowed.
- **Checks:** `npx tsc -p server --noEmit`; `npm run typecheck`; `npm run build`; eslint on the web files you changed.
- **Reuse; don't rebuild:**
  - OpenRouter key: `getOpenRouterKey(userId)` from `server/src/services/api-keys.ts`.
  - Spend guardrails: `checkAccountGuardrails` (`services/account-guardrails.ts`).
  - Spend logging: insert into `generation_logs` like `logIdeaSpend` in `services/ideas/discovery.ts`.
  - Ledger: `startOperationEvent` / `finishOperationEvent` (`services/operation-events.ts`). Add an allowed metadata shape for the new action; counts and cost only.
  - Site settings: `getEffectiveSettings` / `updateSiteSettings` (`services/user-settings.ts`), and the normalize-then-save pattern of `services/ideas/settings.ts`. Competitors come from `getIdeaSettings(...).competitors`; `bareDomain` is there too.
  - Site lookup: `getSiteForUser`.
  - Model choice for helper calls: `resolveOpenRouterTextModel` (`services/openrouter-models.ts`) and `createEngineLlm` / `engineAiEndpoint` (`engine/adapters/llm.ts`).
  - Safe outbound fetch: `services/safe-fetch.ts`.
- **The product boundary** (AGENTS.md): no live publish; answer text, prompts and keys never go into the ledger. The only MCP change in this plan is the one read-only tool in Task 2.
- **The web UI** follows `UI_UX.md` and `docs/design-system/` (BywordCard, SectionHeader, compact, calm, no fake controls).
- Keep diffs focused and match the surrounding code. Commit once per task, with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.
- **Your report:** files changed; the exact exported function names, API and response shapes later tasks depend on; the commands run, with results; and any deviations or doubts.

## Task 1: Data and services

1. **Migration.** `0043_ai_visibility.sql` creates `ai_answer_checks` per the spec. It also adds a `user_settings.ai_visibility jsonb` column; check how `idea_settings` was added in `0040_ideas.sql` and copy that. Mirror both in `schema.ts`.
2. **`services/ai-visibility/settings.ts`.**
   - `normalizeVisibilitySettings(raw, site)` never throws.
   - Default engines: `openai/gpt-5.6-luna`, `perplexity/sonar`, `google/gemini-3.5-flash`. Engines must match `^[a-z0-9-]+/[a-z0-9.:_-]+$`; keep at most 5.
   - `brandTerms` defaults to the site name, the domain, and the domain without its TLD.
   - Add `getVisibilitySettings` and `saveVisibilitySettings`.
   - `ENGINE_LABELS` maps a provider prefix to a label (`openai` to OpenAI, `perplexity` to Perplexity, `google` to Google, `anthropic` to Claude, `x-ai` to Grok); any other prefix uses the prefix itself.
3. **`detect.ts`.** Pure functions, per the spec: `normalizeUrl`, `hostOf`, `siteHostMatch`, `mentions(answer, brandTerms)` and `classify`.
   - Mentions are word-bounded and case-insensitive. Terms shorter than 3 characters are ignored.
   - Hosts are lowercased, with `www.` stripped, and deduped.
4. **`questions.ts`.**
   - `validateQuestions(list, brandTerms)` returns `{questions, errors: [{index, message}]}`. It trims, collapses whitespace, appends "?" when it is missing, and enforces 5–200 characters, no brand term, case-insensitive dedupe, and at most 30 questions.
   - `questionHash` is the sha256 of the lowercased, whitespace-collapsed question.
   - `suggestQuestions(userId, siteId, deps?)` takes these inputs:
     - Search Console queries that read as questions (starting with a question word, or containing "?") from the existing Search Console tables. Find them via `services/search-console.ts`.
     - Recent idea `audienceQuestion`s, `brief.audienceQuestion` or whatever field exists on ideas.
     - Seed topics, from `effectiveSeedTopics`.
     It makes one LLM call with a zod schema `{questions: string[]}`. The prompt says to write questions real customers ask an AI assistant, in the site's language, without naming the brand. It then filters through `validateQuestions` and logs the spend. It returns up to 20.
5. **`engines.ts`.** `askEngine({apiKey, model, question, signal, fetchImpl?})` posts to OpenRouter `/chat/completions` with `plugins:[{id:"web"}]` and `usage:{include:true}`.
   - **Parsing:** `choices[0].message.content` is the answer. URL citations come from `choices[0].message.annotations[].url_citation.{url,title}`. Also accept a top-level `citations: string[]`, which Perplexity returns. `usage.cost` is `costUsd`.
   - **Errors:** a 429 throws `RateLimitError` with `retryAfterMs` from `Retry-After`. A 402, or a body that mentions credits or quota, throws `QuotaError`. A blank answer throws `EmptyAnswerError`. Any other non-2xx throws `EngineError`, with the status and a short message and no body echo. Every error carries `costUsd` when it is known.
   - The timeout is 120 s.
   - Inject `fetchImpl` for tests.
6. **`run.ts`.**
   - `isoWeek(date)` returns `YYYY-Www`.
   - `runVisibility(userId, siteId, opts?: {now?, ask?, sleep?})`:
     - It needs an OpenRouter key; with none, it returns `{status:"unavailable"}`.
     - It checks `checkAccountGuardrails`.
     - It checks the monthly cap: this month's `cost_usd` sum for the site plus an estimate for the pending pairs (pending × the engine's estimate: openai $0.012, perplexity $0.006, google $0.016, others $0.02). Over the cap, it returns `{status:"capped"}`.
     - For each question × engine with no `ok` row this week, it asks the engine. A `failed` row may be retried and is updated in place: upsert `ON CONFLICT (site_id, week, engine, question_hash) DO UPDATE` only when the existing status is `failed`.
     - It classifies each answer and stores it right away. The answer is capped at 4,000 characters.
     - **Pacing:** wait 2 s between calls. On a 429, wait `min(retryAfter, 90s)` and retry at most twice. A `QuotaError` stops that engine for the run.
     - It logs spend per call to `generation_logs` with `responseData: {aiVisibility: {siteId, week}}`.
     - It writes one operation event `ai_visibility.run`, with metadata `{asked, cited, failed, cost_usd}`.
     - It returns `{status:"done", week, asked, cited, failed, costUsd}`.
     - A site-level in-process lock prevents two concurrent runs. Also store `running: {startedAt}` in a small way the API can read: add a nullable `ai_visibility_run_started_at timestamptz` column to `sites` or `user_settings`, whichever is simpler, and clear it when the run finishes. Treat it as stale after 30 minutes.
   - `drainVisibility(now = new Date(), limit = 5)` covers every site with `enabled` and at least one question, where today's UTC weekday is ≥ the configured weekday (Monday counts as the week's start) and some question × engine pair has no `ok` row this ISO week. It runs them one after another, isolating failures.
   - Wire `drainVisibility` into the worker's `daily` task list in `services/background-worker.ts`, named `ai-visibility`.
7. **`summary.ts`.** `visibilitySummary(userId, siteId, now?)` returns the shape in the spec:
   ```
   {week, latest:{questions, answered, citedQuestions, share, mentionedShare, engines:[{engine,label,asked,cited,share}]},
    trend:[{week, share, answered}], topCompetitors:[{host,count,flagged}],
    gaps:[{question, competitorHosts:string[], otherHosts:string[], twoWeeks:boolean}],
    checks:[...latest week rows without user_id], costThisMonth}
   ```
   - The latest week is the most recent week with rows.
   - Shares are cited unique questions divided by answered unique questions, over `ok` rows only. Use 0 when nothing was answered.
   - A gap is a question that no engine cited for the site, where at least one engine cited some other host. Flagged competitor hosts come first. `twoWeeks` is true when the previous week was also a gap.
   - The trend covers the last 12 weeks that have data, oldest first.
8. **Tests** (self-tests):
   - `detect`: the host tricks from the spec, subdomains, `www`, tracking parameters, and brand word boundaries ("lindevo" must not match "lindevonia").
   - `validateQuestions`.
   - `askEngine` with a fake fetch: annotations, Perplexity `citations`, 429, 402, and an empty answer.
   - `runVisibility` on the test DB with a fake `ask` and an instant `sleep`: rows stored; a second run in the same week makes no calls; a failed row is retried; the cap returns `capped`; spend is logged; a quota error skips that engine.
   - `visibilitySummary`: shares, gaps, `twoWeeks` and the trend.

## Task 2: API, MCP tool, ideas link

1. **`server/src/routes/ai-visibility.ts`**, mounted at `/api/ai-visibility` in `server/src/index.ts`, with the same auth middleware as `routes/ideas.ts`. Every route validates that `siteId` belongs to the user, via `getSiteForUser`, and returns 404 otherwise.
   - `GET /?siteId=` returns `{available: boolean, reason?: "no_openrouter_key"|"custom_gateway", settings, summary, running: boolean}`. `custom_gateway` applies when `ENGINE_AI_BASE_URL` is set and the user has no OpenRouter key.
   - `PUT /settings` takes `{siteId, settings}`. It runs `validateQuestions` and returns 400 `{error, errors}` when there are errors. It also validates the engines. It returns `{settings}`. Log a mutation operation event like the other settings routes do, if they do.
   - `POST /suggest` takes `{siteId}` and returns `{questions}`.
   - `POST /run` takes `{siteId}`. It returns 409 when a run is already going, and 400 when there are no questions. Otherwise it starts `runVisibility` detached, the same way the app starts other background work. Check how ideas `discover` starts discovery: if that queues a row for the worker, follow the same pattern only when it is cheap. Otherwise run it detached in-process, and the worker's weekly drain stays the scheduled path. It returns 202 `{started:true}`.
   - `GET /models` returns `{models:[{id,label,searchPrice}]}`: OpenRouter models whose pricing has `web_search`, limited to the providers in `ENGINE_LABELS` and without `:batch` variants. Reuse any existing OpenRouter model-list helper in `services/openrouter-models.ts`, cached.
   - `POST /gap-idea` takes `{siteId, question}`. It calls the existing manual-idea service (`services/ideas/manual.ts` `addManualIdea`) with the question as the title, and returns its result. This is the panel's **Add as idea** button.
   - Route self-tests: another user's site returns 404; a validation failure returns 400.
2. **Ideas signal.** Add `"ai_gap"` to `SIGNAL_SOURCES` in `services/ideas/signals.ts`. Add a collector that turns `visibilitySummary(...).gaps` with `twoWeeks` (or, when there is only one week of data, all gaps) into signals, with the question as the text and the competitor hosts in the detail. Use the existing `Signal` shape and the other collectors' timeout handling. Find every place that switches on the signal source, on the server and in web (labels, icons), and add `ai_gap` with the label "AI answer gap".
3. **MCP tool `get_ai_visibility`.**
   - Add it to the catalog in `server/src/mcp/contracts.ts` with `content:read`, and the handler in `server/src/mcp/tools.ts`. Copy how a site-scoped read tool such as `get_workspace_digest` or a site-scoped idea read tool resolves and checks the site.
   - The input is `{site_id}`. The output is the summary without the `checks[].answer` text, with the latest week's per-question rows shortened to `{question, engine, cited, citedUrls, competitorHosts}`.
   - Update every exact catalog count and tool list, from 26 to 27: `server/src/mcp/server.self-test.ts`, any `contracts` test, `docs/mcp.md`, `AGENTS.md`, `README.md`, and the web Connections UI only if it hardcodes counts. It shouldn't.
4. Tests and checks as in the rules.

## Task 3: Web

1. **API client.** Add types and calls to `web/src/lib/api.ts`, following the existing ideas calls.
2. **`web/src/components/growth/AiVisibilityPanel.tsx`**, placed on `web/src/pages/SearchGrowth.tsx` as a `BywordCard` with `SectionHeader` "Cited in AI answers":
   - **When it is unavailable:** one calm line that names the reason: add an OpenRouter key in Control → Integrations, or self-hosted gateways aren't supported for this check yet. No fake controls.
   - **When there are no questions:** an empty state that explains the check, with an **Add questions** button that opens the editor.
   - **Header row:**
     - the big share percentage of questions cited this week, with "N of M questions";
     - the mentioned share as secondary text;
     - a sparkline of the trend as a small inline SVG (no chart library unless one is already installed and used on this page: check);
     - a **Run now** button (disabled while running; poll every 5 s while `running`);
     - a **Settings** button.
   - **Engines:** a compact table with engine label, cited of asked, and share.
   - **Competitors:** the top domains as compact chips with counts. Flagged competitors are marked.
   - **Gaps:** a list of questions with competitor hosts and **Add as idea**, which calls `POST /gap-idea`. Afterwards it shows "Added" and links to `/ideas`.
   - **Questions:** an expandable list of each question with per-engine status dots (cited, not cited, failed). Expanding a question shows each engine's cited site pages, the other hosts, and the answer text (collapsed, plain text, never HTML).
   - **Settings dialog** (shadcn Dialog):
     - a questions textarea, one per line, showing the validation errors returned by the server;
     - a **Suggest** button that fills suggestions as checkable items;
     - engines as checkboxes from `/models`;
     - a weekday select;
     - the monthly cap in USD;
     - brand terms;
     - an enabled switch;
     - **Save**.
   - Cost this month is a small muted line.
3. **Overview.** Add one number in `web/src/pages/Overview.tsx` using the same `GET /api/ai-visibility` query: "Cited in AI answers: X% this week", linking to `/overview/growth`. Hide it when the feature is unavailable or has no data. Use the active-site pattern the page already uses.
4. **Tests:** vitest for the panel, covering the unavailable state, the empty state, data rendering (share, gaps, engines), and the settings dialog showing server validation errors.
5. Lint, typecheck, test and build.

## Task 4: Lindevo history import

1. **`server/src/scripts/import-lindevo-citations.ts`**, run as `bun run src/scripts/import-lindevo-citations.ts --site <siteId> --source-url <postgres url> [--dry-run]`. Add the npm script `import:lindevo-citations` to `server/package.json`, and a root alias if the root has script aliases for server scripts.
   - It reads the source table read-only (`SET TRANSACTION READ ONLY`). Look in `/home/nauris/Projects/lindevo` for the schema and table, probably `content_engine.ai_citations`.
   - It finds the site's owner `user_id` from `sites`.
   - **Mapping:**
     - `run_key` becomes `week`;
     - `engine` `gemini-grounded` becomes `google/gemini (Lindevo import)` with the label Google, and `openai-web` becomes `openai/web (Lindevo import)` with the label OpenAI;
     - `lindevo_cited` becomes `cited`, and `lindevo_urls` becomes `cited_urls`;
     - `other_hosts` is computed from `cited_urls` minus the site hosts via `classify`, and `mentioned` via `classify` too;
     - `status` is `ok` when the answer is non-empty, otherwise `failed`;
     - `cost_usd` is 0;
     - `asked_at` is copied.
   - It inserts with `ON CONFLICT DO NOTHING`, and prints the counts read, inserted and skipped.
2. A self-test of the pure row mapper.
3. Document the command in `docs/operations.md`.
