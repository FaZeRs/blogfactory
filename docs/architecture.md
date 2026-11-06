# Architecture and developer map

This document explains how the current BlogFactory system fits together. It describes shipped code, not future pricing or launch plans.

## System at a glance

```text
                         public visitors
                               |
                     blogfactory.io (Cloudflare)
                               |
                    marketing one-pager + waitlist

operators ------------------------------------------------ agents
    |                                                         |
app.blogfactory.io                                      blogfactory.io/mcp
    |                                                         |
React control app                                      MCP auth + tools
    |                                                         |
    +--------------------- Hono API ---------------------------+
                              |
                   shared tenant-scoped services
                              |
      Hetzner PostgreSQL + Cloudflare R2 object storage
                              |
       CMS drafts / Search Console / configured AI providers
```

The important architectural rule is that web and MCP are two transports over the same services. Queue classification, review preflight, revision logic, Search Console reads, permissions, and CMS draft delivery should not be reimplemented in a page or MCP handler.

Community deployments use the same boundary on the installer's domain: Nginx serves the web app and proxies `/api/*` and `/mcp` to the private Hono service; PostgreSQL, MinIO, and the scheduler also run in the installer's infrastructure. Community MCP tokens, content, credentials, and operation events never route through BlogFactory Cloud.

## Runtime surfaces

### Public marketing

The private `BlogFactoryHQ/blogfactory-marketing` Astro repository is the sole source for `blogfactory.io`, its blog, documentation, waitlist, and future pricing content. Cloudflare Pages serves that repository and proxies only the allowlisted API, MCP, and OAuth compatibility routes to `app.blogfactory.io`. This public application repository does not build a second marketing page.

### Authenticated web app

- HTML entry: `web/index.html`
- React entry: `web/src/main.tsx`
- Route tree: `web/src/App.tsx`
- API client: `web/src/lib/api.ts`
- Session and site context: `web/src/hooks/useAuth.tsx`, `web/src/hooks/useSites.tsx`

The app is the operator control plane. Pages should call typed hooks/API helpers and render state; shared product decisions belong in backend services.

### MCP server and Review Card

- Endpoint: `/mcp`
- Transport: `server/src/mcp/server.ts`
- Exact catalog/scopes/version: `server/src/mcp/contracts.ts`
- Schemas and handlers: `server/src/mcp/tools.ts`
- Authentication: `server/src/mcp/auth.ts`, `server/src/mcp/oauth.ts`
- Standalone app resource: `server/src/mcp/review-app.ts`
- Frontend card: `web/src/mcp-review/`

The MCP surface is site-scoped and draft-only. `generate_draft` is asynchronous. `update_draft` and `push_to_cms_draft` require the current version. Repeating the same CMS draft delivery is idempotent.

### HTTP API

`server/src/index.ts` assembles the Hono app. The order is deliberate:

```text
CORS -> request logger -> normalized errors -> auth -> operation ledger -> routes
```

Production runs the Hono app with Bun in the API container. `api/index.js` remains the compatible Vercel serverless entrypoint used by the ready rollback deployment. Route files own HTTP validation and response shape; business logic should live under `server/src/services/`.

## Service ownership

| Concern | Source of truth | Main consumers |
| --- | --- | --- |
| Workspace digest, action queue, review packet | `server/src/services/control-plane.ts` | Overview, Review Queue, MCP |
| Revisions and optimistic locking | `server/src/services/post-revisions.ts` | Post routes, review, MCP updates |
| CMS preflight and draft delivery | `server/src/services/publishing.ts` | Web approval and MCP Review Card |
| Content generation | `server/src/services/generate-content.ts` | Content routes, campaigns, MCP |
| Generation contracts and output cleanup | `generation-contracts.ts`, `generation-output.ts`, `post-cleanup.ts` | Generation and repair flows |
| Search Console | `server/src/services/search-console.ts` | Search Growth, digest, MCP |
| SEO growth plans | `server/src/services/seo-growth-plan.ts` | Search Growth and campaigns |
| Page optimization | `server/src/services/optimize.ts` | Search Growth Optimize surface |
| Internal links and indexing | `internal-linking.ts`, `indexing.ts` | Search Growth and post delivery |
| RSS routing and leases | `feed-routing.ts`, `feed-run-lease.ts` | Feed routes and schedulers |
| Campaign execution | `campaign-runner.ts`, `campaign-parser.ts`, `programmatic.ts` | Campaign and programmatic routes |
| Images | `image-slots.ts`, `low-cost-images.ts`, `ai-image-queue.ts`, `image-storage.ts` | Generation, gallery, background drains |
| Credentials | `api-keys.ts` and integration-specific services | Settings, generation, publishing |
| Audit history | `operation-events.ts`, `middleware/operation-ledger.ts` | Operations API and Overview |

## Data and tenancy

- Schema: `server/src/db/schema.ts`
- Database connection: `server/src/db/index.ts`
- Additive migrations: `server/src/db/migrations/`
- Migration runner: `server/src/db/migration-runner.ts`

Every authenticated query and mutation must remain user- and site-scoped. The main consistency guarantees are:

- post edits use optimistic locking;
- CMS draft delivery is idempotent;
- background feed work uses PostgreSQL leases;
- operation records are sanitized and retained for 30 days;
- secrets are encrypted at rest and never returned through MCP;
- integration tests use a disposable PostgreSQL database.

Object storage holds generated/imported image assets. Database rows retain ownership, attachment, source, status, and attribution metadata; the object key alone is not an authorization boundary.

## Background work

Production heavy work runs in the private Cloud repository's persistent worker process. It polls every five seconds and drains at most one campaign item, two SEO jobs, and one deferred-image job per cycle using the existing PostgreSQL claims, retries, stale recovery, and terminal states. The worker runs `server/src/worker.ts` with `BACKGROUND_EXECUTION_MODE=worker`; the API runs `inline`. No Redis or external queue is involved.

The worker also owns periodic work; one thin external trigger remains as a fallback:

| Trigger | Schedule | Work |
| --- | --- | --- |
| Persistent worker | Every 5 seconds | Campaigns, SEO metadata, deferred images |
| Persistent worker | Every 6 hours and on start | Due RSS feeds |
| Persistent worker | Daily and on start | Google indexing, Search Console, expired operation events |
| Cloudflare Worker | Every 6 hours | Protected bounded fallback drain |

Self-hosted Compose and Dokploy installs keep their own `scheduler` container calling the all-task drain.

The backend decides eligibility and claims work. Schedulers must stay thin; do not create a second queue or duplicate job classification in a Worker or workflow.

## Staged blog engine

`server/src/engine/` runs the `normal` and `deep` generation modes as durable stages (research, brief, draft, quality gates, revise, deliver). `article-runs.ts` starts a run from the same generation request as fast mode; state lives in `article_runs`, with `article_stage_runs`, `article_sources`, `article_evidence`, and `article_gate_results` as user-scoped children. The worker's `articles` drain claims runs with a lease and advances one stage at a time; retries, 429 rescheduling, and lease recovery are in `engine/runtime/`. Search (SearXNG or DataForSEO), page reading (Crawl4AI or plain fetch), and the LLM client are adapters in `engine/adapters/`; the LLM is OpenAI-compatible (the user's OpenRouter key, or the instance `ENGINE_AI_*` endpoint). Engine settings are per user at `GET/PUT /api/settings/engine`. The engine delivers a draft post only; escalated runs reach the Review Queue as `engine_escalated`. Fast mode does not use the engine. `npm run eval:engine` runs the golden-brief eval harness.

**Quality loop.** After the code gates pass, the `review` stage reads the draft with the `review` model role (default: the mode's writer):
- **Fact-check** (normal and deep) checks the draft against the verified evidence.
- **Reader review** (deep only) reads it as the brief's audience.
- **What blocks:** a contradiction, a cited claim its quote doesn't support, an unsourced number, and (reader) a planned step or question that's missing. Everything else is a warning.
- **Discarded:** an issue whose excerpt isn't in the draft.
- **Loop:** blockers go to `revise`, then gates, then review again, sharing `maxRevise` (normal 2, deep 3) and the stall rule.
- **Other checks:**
  - the `style` code gate blocks machine-sounding phrases and heavy em-dash use;
  - the voice gate also blocks the site's own banned words (as whole words) and phrases (`user_settings.content_rules`).
- **Prompt context:** the brief, draft and revise prompts get the site's voice rules plus its brand profile (company, audience, value propositions, CTAs and the most relevant knowledge chunks) through `writerVoice`.
- **Draft repair:** `normalizeDraftMarkdown` repairs drafts that cheap models flatten (line breaks returned as spaces) or write as HTML.

**Revise with comments:** `POST /api/posts/:id/revise-with-comments` rewrites a post from the owner's comments, with the run's evidence when there is one, and saves a new revision under the same optimistic lock. It adds no MCP tool.

**Evals:** `npm run eval:engine -- --mode normal@<model>` runs every role on one model, and `#noreview` skips the review stage, so cheap or free OpenRouter models and the quality loop can be compared on the golden briefs. Reports record every finding by revise round.

Research also reads the top-ranking pages for the topic (`article_sources.kind = 'competitor'`), extracts their outlines and the questions people ask, and produces a gap and information-gain analysis that the brief plans around. When a run's destination is Lindevo (`componentProfile` in `engine/profile.ts`), the brief, draft and revise prompts use Lindevo's markdown components, the `components` gate checks them with Lindevo's linter vendored in `engine/components/`, and deliver appends the `<provenance>` block. Other destinations get plain Markdown.

## Ideas and scheduling

`server/src/services/ideas/` finds and schedules article ideas per site:
- **Discovery** (`ideas.discovery`, the worker's `ideas` drain) collects signals from Search Console, SearXNG news, DataForSEO keyword ideas and People also ask, the site's RSS feeds, and competitor sitemaps.
- **Scoring:** one model call turns the signals into candidates, and code scores them as a weighted geometric mean of trend, fit, demand, feasibility, novelty and information gain.
- **Approval:** ideas wait in `ideas` (status `new`) for the owner. Approving books a cadence slot (`schedule.ts`, which never double-books).
- **Generation:** `startDueIdeas` starts a normal or deep run `leadDays` before the slot. The delivered draft carries `posts.publish_at`, which the Send to CMS dialog pre-fills. Delivery stays draft-only.

The routes are under `/api/ideas`, with settings at `/api/settings/ideas`. The web surface is `/ideas` (Inbox, Planned, Calendar, Settings). The MCP tools `list_ideas`, `discover_ideas`, `approve_idea`, and `reject_idea` call the same `services/ideas/actions.ts` functions as the routes.

**Weight learning** (`learning.ts`): the worker's daily task, once per UTC month per site, nudges each score weight (at most 10%, bounds 0.1-3) by its Pearson correlation with ln(1 + Search Console clicks) in days 30-58 after publication, needing at least 5 published ideas. State lives in `idea_settings` (`learnWeights`, `weightsLearnedMonth`, `weightHistory`).

## AI answer visibility

`server/src/services/ai-visibility/` checks whether AI answer engines cite each site:
- **Questions and engines** live in `user_settings.ai_visibility` per site. There are 5-30 questions, which may not name the brand, and up to 5 OpenRouter models. `suggestQuestions` drafts questions from Search Console queries, idea questions and seed topics.
- **A run** (`run.ts`) asks each question to each engine once per ISO week (`ai_answer_checks`, unique on site, week, engine and question hash):
  - It uses OpenRouter `plugins:[{id:"web"}]` and reads `url_citation` annotations. Gemini's redirect links are resolved with one manual-redirect HEAD to Google's fixed host.
  - Calls run one at a time with a 2 s pause. A 429 is waited out (at most twice, 90 s each); a quota error stops that engine for the run. An empty answer is stored as a failure.
  - The run claims `sites.ai_visibility_run_started_at` (stale after 30 minutes).
  - Spend is logged to `generation_logs` per call. The run is skipped when this month's spend plus the run's estimate would pass the site's cap.
  - It writes one `ai_visibility.run` ledger event (counts and cost only). The answer text is capped at 4,000 characters and never enters the ledger.
- **Detection** (`detect.ts`): *cited* means a cited URL on the site's domain or a subdomain; *mentioned* is a word-bounded brand-term match. Every other host is stored, and hosts in the idea settings' competitor list are flagged.
- **Summary** (`summary.ts`): the share of answered questions cited, per engine and over 12 weeks, the top cited domains, and gaps (a competitor cited, the site not).
- **Ideas:** gaps that hold for two weeks become `ai_gap` discovery signals, and the panel's **Add as idea** creates a manual idea.

The worker's hourly `ai-visibility` task runs `drainVisibility` (at most 5 sites per pass) for enabled sites once their weekday arrives. A run rechecks the account guardrails before every paid call, and the monthly cap is read from the spend log. Scheduled passes retry a failed pair only after 6 hours. **Run now** needs the persistent worker host (`BACKGROUND_EXECUTION_MODE=worker`), since a serverless function would cut a run of minutes short. The routes are under `/api/ai-visibility`; the web panel is on Search Growth, with one number on Overview. The MCP tool `get_ai_visibility` (`content:read`) returns the summary without answer text and never starts a run.

## Hosting and routing

| Layer | Current responsibility |
| --- | --- |
| Cloudflare | Private-repository public apex/front door and six-hour cron Worker |
| Private `BlogFactoryHQ/blogfactory-cloud` | Cloud-only Compose, Caddy, image-build, and deployment ownership |
| Hetzner Nuremberg | PostgreSQL 18, API, worker, backup, and web container runtime |
| Cloudflare R2 EU | Private production image/object storage and encrypted portable backup |
| GitHub Actions + GHCR | Validation and immutable API/web image builds by commit SHA; no scheduled production drains |
| Vercel project `editorial-flow-main` | Last clean serverless deployment retained as the DNS rollback target |

The pre-cutover Neon database and manual snapshot remain available only as a
short-term rollback source. Current writes go to the private Hetzner Compose
PostgreSQL service; encrypted R2 backups are the durable recovery source.

For self-hosting, `WEB_APP_URL` is the browser origin used in review/preview links, `MCP_APP_URL` is the API's internal Review Card fetch URL, and `/api/mcp/capabilities` returns the instance-local MCP endpoint. The API honors the platform-provided `PORT`; the Nginx image resolves its private backend at runtime through `API_UPSTREAM`.

This repository is the canonical shared core for the authenticated app, public self-hosting help/docs entries, and standalone MCP Review Card. Production uses the private marketing repository at the public apex and the private Cloud overlay at the app subdomain. Cloudflare proxies `app.blogfactory.io` to Caddy on Hetzner; Caddy forwards to the loopback-bound Nginx web container, which proxies API and MCP traffic to the private Hono container. Shared changes originate here and sync into Cloud; private Cloud changes never sync back automatically. Verify actual DNS, image digests, and proxy behavior during every release; do not infer live routing from configuration alone.

## Authentication and authority

- Web sessions use application authentication and site membership.
- MCP accepts WorkOS browser OAuth or hashed personal `bf_mcp_` tokens.
- OAuth fails closed unless issuer, resource URL, and WorkOS key are configured together.
- MCP scopes are `content:read`, `drafts:write`, and `publish:draft`.
- `publish:draft` means CMS draft delivery, never live publication.
- Hosted public signup is disabled; self-hosted signup is an environment-gated administrator bootstrap path.
- Password recovery UI is disabled until real email delivery is connected.

## Pricing boundary

There is no BlogFactory customer billing system in this codebase. Existing “pricing” fields describe upstream AI model costs for bring-your-own-AI usage. The live Cloud packaging is summarized in [`FEATURE_PLAN.md`](../FEATURE_PLAN.md); checkout, subscriptions, and entitlements are implemented in the private Cloud repository.

Do not add checkout to this core. Keep customer billing outside MCP tool authority, make billing webhooks idempotent, and do not treat model-cost analytics as subscription state.

## Where to make a change

| If you need to change… | Start here |
| --- | --- |
| Public one-pager, blog, waitlist, or future pricing | private `BlogFactoryHQ/blogfactory-marketing` repository |
| Hosted app deployment, Cloud-only code, billing, or entitlements | private `BlogFactoryHQ/blogfactory-cloud` repository |
| App navigation or route | `web/src/App.tsx`, `web/src/components/layout/AppSidebar.tsx` |
| Shared page chrome | `web/src/components/layout/BywordSurface.tsx`, `UI_UX.md` |
| API endpoint | matching file under `server/src/routes/`, then a shared service |
| Database field | `server/src/db/schema.ts` plus a new additive migration |
| MCP tool | `contracts.ts`, `tools.ts`, exact catalog assertions, `docs/mcp.md` |
| Review/preflight behavior | `server/src/services/control-plane.ts` or `publishing.ts` |
| Scheduled work | `server/src/routes/cron.ts`, existing drain service, current trigger config |
| Production routing | private Cloud Compose/Caddy, Cloudflare, `docs/operations.md` |

## Developer reading order

1. `README.md`
2. This document
3. `AGENTS.md`
4. `docs/mcp.md` for MCP or agent work
5. `docs/operations.md` for database, jobs, or release work
6. `UI_UX.md` for frontend work

Historical plans preserve decisions but are not evidence of current behavior. When documentation disagrees, confirm the code and update the current document in the same change.
