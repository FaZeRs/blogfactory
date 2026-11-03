# Blog engine: staged generation modes — design spec

> Status: design agreed with Nauris on 2026-11-03 (brainstorming, four sections, each approved). Forward plan: nothing here is shipped until the matching item is checked in [`FEATURE_PLAN.md`](../../../FEATURE_PLAN.md) and verified in code.
> Source system: the Lindevo content engine (`~/Projects/lindevo/apps/content-engine`, `apps/engine-console`) and its specs under `lindevo/docs/superpowers/specs/2026-10-*`.

## Goal

Make BlogFactory the tool that produces the best blog posts we can make: engaging, SEO-optimized, original, easy to read, factually correct and researched. To get there, move the Lindevo content engine's editorial pipeline into BlogFactory as multi-tenant generation modes, then retire the Lindevo engine.

The draft-only boundary does not change. Better generation makes drafts better and easier to approve; it never publishes.

## Program decisions

| Topic | Decision |
|---|---|
| Audience | Tiers. Today's one-shot generator stays as **fast**. New **normal** and **deep** modes run a staged pipeline. Dogfooded on Lindevo first, available to all customers |
| Default mode | **Normal** becomes the default for manual generations once the eval shows it beats fast. Fast stays the default for RSS feeds and campaigns |
| Lindevo engine | Retired completely after an overlap (cutover rules below). BlogFactory's Review Queue and Runs pages replace the Notion board and the engine console. Social posts and CRM are out of scope |
| Models | The existing OpenRouter key flow. A self-hosted instance may set `ENGINE_AI_BASE_URL` (+ `ENGINE_AI_API_KEY`) to point the engine's OpenAI-compatible client at its own gateway (LiteLLM). Never set on Cloud: it would apply to every tenant |
| Research data | Optional instance-level adapters, set by environment variables, each with a fallback: SearXNG (search), Crawl4AI (page reader), DataForSEO (keyword data, results pages, People Also Ask, AI Overview). This is the explicit provider decision `docs/research-plan.md` asked for; it replaces that plan's Serper choice |
| Nauris's instance | Self-hosted BlogFactory on a new home-lab VM with LAN access to SearXNG, Crawl4AI (CT116) and LiteLLM (CT121). Not CT125 |
| Publishing | Draft-only. Delivery may carry a `publish_at` date; the destination CMS owns scheduling and publishing. For Lindevo, the Lindevo CMS gets `publishAt` and its own publish cron (separate change in the `lindevo` repo) |
| Quality bar | An eval harness ships in sub-project 1. Cutover requires a pairwise win against the Lindevo engine on the golden set **and** 6 real Lindevo posts approved with light edits at most |
| Code migration | Port the logic, rebuild the runtime. Pure modules (gates, evidence, sanitizer, prompts, stage schemas, judges, DataForSEO and crawl adapters) move with their tests. The runtime is rebuilt on BlogFactory's tenant-scoped tables and background worker. Notion, Paperclip, Discord, the Claude CLI router and node-exporter metrics are not carried over |

## Modes

Normal and deep are presets of one staged runtime. Fast is the existing `generate-content.ts`, unchanged.

| | Fast | Normal | Deep |
|---|---|---|---|
| Engine | `generate-content.ts` | staged runtime | staged runtime |
| Research | none | search, read pages, verified quotes | the same, plus DataForSEO keyword data, People Also Ask, more sources |
| Brief | optional outline | brief with claim ids | brief with claim ids, keyword target, competitor gaps |
| Citations | no | yes | yes |
| Code gates | SEO score | all gates | all gates |
| Revise loops | length and language repair | 1 | 2 |
| Adversarial fact-check and reader persona | no | no | yes (sub-project 3) |
| Models | the one you pick | cheap or mid tier | strong tier |
| Rough cost per post (to be measured) | cents | about $0.10–0.50 | about $1–3 |

Normal absorbs research-plan slice R1. A preset is data in `server/src/engine/modes.ts`: `{ stages, roleModels, maxRevise, researchBudget }`. A stage not in the preset is skipped.

## Sub-projects

Each gets its own spec, plan and implementation cycle. This document covers the program and **sub-project 1** in detail.

1. **Staged runtime + eval harness + normal/deep end to end** (this spec).
2. **Research depth:** more sources, DataForSEO brief data, competitor gaps (deep).
3. **Quality loop:** adversarial fact-check, reader persona, sanitizer, revising from reviewer comments (`human-revise`).
4. **Topic discovery:** radar, scored slate, pgvector novelty, refresh candidates. Absorbs research-plan R3.
5. **Localization:** native second language, glossary, parity gate.
6. **Learning:** reviewer edit diffs to style rules checked by evals; performance snapshots to refresh queue.
7. **Covers, provenance box, distribution pack.**
8. **AI answer visibility:** weekly probe of answer engines for whether the site is cited (below).

Cutover needs 1, 3, 5 and 8 at least.

## Sub-project 1 design

### Scope

One normal or deep article goes end to end: research → brief → draft → gates → revise → BlogFactory post in the Review Queue → CMS draft (with optional `publish_at`). Each step is a recorded, resumable stage run.

### Data model

One additive migration, `0037_article_runs.sql`. Every row carries `user_id` and `site_id`; every query filters on both.

- `article_runs`: one per article. Mode, topic, locale, destination, `current_stage`, `state` (`active` / `waiting_human` / `done` / `failed` / `escalated`), `lease_owner`, `lease_expires_at`, `version` (optimistic lock), `budget_usd`, `spent_usd`, `job_id`, `post_id`, timestamps.
- `article_stage_runs`: one per stage attempt, unique `(run_id, stage, attempt)`. `input_hash`, model, prompt version, tokens, `cost_usd`, status, `output` jsonb, error, `started_at`, `finished_at`.
- `article_sources`: URL, `fetched_via` (`crawl4ai` / `safe-fetch`), HTTP status, text length, title, `fetched_at`.
- `article_evidence`: claim, quote, `verified`, method (`exact` / `windowed`), ratio, `source_id`.
- `article_gate_results`: gate, attempt, passed, severity, detail.

The eval harness uses no tables (see Testing).

### Runtime

- No second job system. The existing background worker (`background-worker.ts`) gets an `articles` drain beside campaigns, SEO and images.
- Each poll claims up to N runs with one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT N) RETURNING` statement and advances each by **one** stage. A stage commits only if the lease owner and `version` still match.
- A stage whose `input_hash` matches an earlier succeeded stage run reuses its stored output.
- Every run also has a `jobs` row, so the Runs page, active-jobs panel and stale-job recovery keep working. `jobs.current_step` mirrors the stage.
- Budget: before each stage, spent + estimate must fit under the run cap and the existing guardrails (daily and monthly). Otherwise the run pauses with "$X of $Y spent".

### Code layout

`server/src/engine/`:
- `modes.ts`: the presets.
- `runtime/`: claim, lease, advance, reuse, budget.
- `stages/<key>/{index,schema}.ts`, with ported tests.
- `gates/`, `evidence/`: pure modules ported from Lindevo.
- `adapters/`: `llm.ts`, `search-searxng.ts`, `search-dataforseo.ts`, `reader-crawl4ai.ts`, `reader-fetch.ts`, `dataforseo.ts`, and a fake for each.
- `prompts/*.md`: versioned; each stage run records the version it used.

Lindevo tests use `bun:test`. They are converted to the server's `*.self-test.ts` convention or kept runnable under Bun; the plan decides per file.

Only the `@acme/engine-kit` helpers actually used are copied in. The `@acme/mdx` component lint becomes a "Lindevo components" gate profile, applied only when the destination is Lindevo; other destinations get plain Markdown.

### Stages

| Stage | What it does | Ported from |
|---|---|---|
| `research` | plan queries → search → read pages → extract claims → code verifies the quotes (normalized substring, or windowed match with numbers matching verbatim). Needs at least 3 verified claims, otherwise it escalates | `stages/research`, `evidence/*` |
| `brief` | angle, outline sections with claim ids, FAQ, takeaways, internal links from BlogFactory's existing link index (`internal-linking.ts`), and the keyword target when DataForSEO is configured | `stages/brief` |
| `draft` | Markdown with `{{c:id}}` markers; code renders them as inline links or a reference list (user setting) | `stages/draft` |
| `gates` | structure, meta lengths, links, source overlap (8-gram ≤5%), similarity to the site's existing posts, word range, plus the Lindevo component lint for Lindevo destinations | `gates/*` |
| `revise` | fixes gate failures; at most `maxRevise` loops, stopping early if blockers do not shrink, then escalates | `stages/revise` |
| `deliver` | creates the BlogFactory post and its first revision, editorial state `in_review` | new |

### Adapters

All are instance-level and set by environment variables, with a fake for tests.

- **LLM** (`adapters/llm.ts`): OpenAI-compatible chat with a JSON schema. Base URL `ENGINE_AI_BASE_URL`, defaulting to OpenRouter. Key: the user's OpenRouter key, or `ENGINE_AI_API_KEY` when the base URL is overridden. Cost comes from OpenRouter usage or LiteLLM's `x-litellm-response-cost` header. Only the engine uses this client; fast mode's existing OpenRouter call sites are unchanged.
- **Search:** SearXNG (`SEARXNG_URL`), falling back to DataForSEO results pages, falling back to none (the run escalates).
- **Page reader:** Crawl4AI (`CRAWL4AI_URL`), falling back to `safe-fetch.ts` + `extract-content.ts`. Every source records `fetched_via`, so Crawl4AI's value can be measured: usable-text rate, verified-quote rate, empty pages.
- **Keyword data:** DataForSEO (`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`) with its own monthly cap (`DATAFORSEO_MONTHLY_USD`). Without it, the brief records "no keyword data".

Models per role (`research`, `brief`, `draft`, `revise`) come from a new `engineModels` user setting, with defaults per mode.

### Surfaces

- **Create Content:** a Fast / Normal / Deep choice. Normal and deep show a cost estimate before starting, and which research adapters are configured on the instance. In sub-project 1 they support the keyword, title and topic source types; RSS and campaigns stay fast.
- **MCP:** `generate_draft` gets an optional `mode: "fast" | "normal" | "deep"`, default `fast`. No new tool; the catalog stays at 22 tools; scopes are unchanged; the result stays asynchronous.
- **Article Settings:** an Engine section with model per role, per-run cost cap and citation style.
- **Runs:** a run's stages from `article_stage_runs` (status, model, cost, duration, attempts) in the existing `RunWaterfall`.
- **Action queue:** failed and escalated runs become **blocker** items through the existing classification in `control-plane.ts`.
- **Review packet** (`GET /api/posts/:id/review`, MCP `review_post`): a Sources section with verified claims, quotes, links, `fetched_via`, and a gate summary.
- **Delivery:** approval and `push_to_cms_draft` are unchanged (explicit destination, preflight, optimistic locking, idempotency). An optional `publish_at` is passed only to destinations that support it.
- **Ledger:** run and stage transitions write sanitized operation events (stage, status, cost, duration). Prompts, sources, quotes and model responses never enter the ledger.

Out of sub-project 1: revising from reviewer comments, adversarial and persona stages, localization, covers.

### Error handling

| Failure | Behaviour |
|---|---|
| Provider 429 or quota | reschedule with backoff; no attempt is used |
| Stage error | retry at about 10 then 30 minutes; after 3 attempts the run fails and becomes a blocker item with the reason |
| Fewer than 3 verified claims | escalate with the queries and sources tried; never a silent draft without evidence |
| Gates still failing after the revise limit, or blockers not shrinking | escalate with the remaining failures; the draft is kept for manual editing |
| Adapter down | use the fallback and record it; escalate only if every search path is down |
| Budget cap reached | pause before the stage; resume when the cap is raised |
| Lease expired (worker crash) | another worker reclaims; stored outputs are reused by `input_hash` |
| Post edited while a run writes to it | optimistic `version` check; a run never overwrites a human edit |

### Testing

- Ported unit tests for gates, evidence verification, normalization, stage schemas, and the DataForSEO and crawl adapters.
- Runtime tests: lease claim and steal, version conflict, `input_hash` reuse, 429 without using an attempt, budget pause, preset stage skipping, tenant isolation (one user's worker never reads another user's run).
- Fake adapters: LLM replay fixtures keyed by stage and input hash, plus fake search, reader and DataForSEO. One normal and one deep run end to end with no network.
- PostgreSQL integration on a disposable database: migration, claim statement, delivery handoff.
- MCP: the exact catalog assertion still shows 22 tools; `generate_draft` accepts `mode`.
- Eval harness, `npm run eval:engine`: golden briefs with frozen evidence (about 7 Lindevo topics plus at least 3 others: a Turkish local business, an e-commerce shop, an app site), rubric and pairwise judges ported from `lindevo/apps/content-engine/prompts/judge-*.md`, and a JSON report. Run before any prompt or stage change merges. In sub-project 1 the "nothing gets worse" rule is checked by hand.

## AI answer visibility (sub-project 8, summary)

Replaces the Lindevo probe (`jobs/probe.ts`, `ai_citations`).

- Per site: matches the site's own domain and brand name, not a hardcoded pattern. A per-site question list is edited in Search Growth.
- Answer engines go through the engine LLM client: OpenRouter web search on Cloud; on a self-hosted instance with a gateway, its routes (Gemini grounding, `/v1/responses` web search).
- Table `ai_answer_citations`: user, site, question, engine, week, cited, cited URLs, competitor domains cited. Answer text is capped and never enters the ledger.
- A weekly periodic task in the existing worker, with a monthly cost cap per site.
- Search Growth (`/overview/growth`) gets a "Cited in AI answers" panel: share of questions citing the site per engine, weekly trend, and questions that cite competitors but not the site. Overview shows one summary number.
- Lindevo's existing `ai_citations` history is imported (size and shape still to be checked).
- Later, sub-project 4 turns "competitor cited, site not" questions into topic candidates.

## Cutover from the Lindevo engine

1. The home-lab VM runs self-hosted BlogFactory with SearXNG, Crawl4AI, LiteLLM and DataForSEO configured.
2. The Lindevo CMS supports `publishAt` with its own publish cron.
3. AI answer visibility runs in BlogFactory, with history imported and at least 2 weeks overlapping the Lindevo probe.
4. Sub-projects 3 (quality loop) and 5 (localization) have shipped, since the Lindevo blog needs both.
5. Deep mode wins the pairwise judge against Lindevo engine outputs on the golden set.
6. Nauris approves 6 real Lindevo posts from deep mode, each with light edits at most.
7. Then the Lindevo engine timers stop, its data is exported, and CT125 is turned off.

## Boundaries that do not change

- Draft-only delivery, explicit destination, preflight, optimistic locking, idempotency.
- MCP authority does not grow: one optional parameter, no new tool, no new scope.
- Every query and stored artifact is user- and site-scoped.
- No second provider flow: one OpenAI-compatible client; the base-URL override is instance-level only.
- Schema changes are additive.
