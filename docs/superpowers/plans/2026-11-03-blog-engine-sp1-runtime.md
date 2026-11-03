# Blog engine sub-project 1: staged runtime, normal/deep modes, eval harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A normal or deep article runs end to end — research → brief → draft → gates → revise → BlogFactory post in the Review Queue — as recorded, resumable, tenant-scoped stage runs on the existing background worker, with an eval harness to measure it.

**Architecture:** New `server/src/engine/` holds pure modules ported from the Lindevo content engine (evidence verification, gates, citations, stages, prompts, eval judges) and a small runtime rebuilt on BlogFactory tables (`article_runs`, `article_stage_runs`, …). The background worker gets an `articles` drain that claims runs with `FOR UPDATE SKIP LOCKED` and advances each by one stage. Web and MCP start runs through one shared service; fast mode (`generate-content.ts`) is untouched apart from one extracted budget helper.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle + PostgreSQL (raw SQL migrations), zod 4, `marked` (new), React 18 + React Query.

**Spec:** `docs/superpowers/specs/2026-11-03-blog-engine-design.md`. Port source: `~/Projects/lindevo/apps/content-engine/src` (referred to below as `LV/`) and `~/Projects/lindevo/packages/mdx/src` (`MDX/`).

## Global Constraints

- Every query and mutation on the new tables filters on `user_id`, and on `site_id` where the caller is site-scoped.
- Schema changes are additive only: one migration `server/src/db/migrations/0037_article_runs.sql`.
- Draft-only. No stage publishes. `push_to_cms_draft` keeps explicit destination, preflight, optimistic locking and idempotency.
- MCP: no new tool, no new scope. `server/src/mcp/server.self-test.ts` keeps asserting 22 tools.
- One provider flow: the engine's LLM client is OpenAI-compatible. Base URL `ENGINE_AI_BASE_URL` (default `https://openrouter.ai/api/v1`); key is the user's OpenRouter key, or `ENGINE_AI_API_KEY` when `ENGINE_AI_BASE_URL` is set. Fast mode's existing OpenRouter call sites are not changed.
- Instance adapters, all optional: `SEARXNG_URL`, `CRAWL4AI_URL` (+ optional `CRAWL4AI_TOKEN`), `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `DATAFORSEO_MONTHLY_USD` (default `10`).
- Normal and deep need `BACKGROUND_EXECUTION_MODE=worker` (the default Compose stack has no persistent worker). Without it, starting a normal/deep run returns a clear error and fast still works.
- Verified research needs at least **3** verified claims; otherwise the run escalates.
- Revise loops: normal **1**, deep **2**; stop early when the blocker count does not shrink.
- Stage retries: about **10** then **30** minutes; a run fails after **3** attempts of one stage. A 429/quota error reschedules without using an attempt.
- Source overlap gate: 8-word grams, ≤ **5%** of the article.
- Operation ledger: stage, status, cost, duration only. Never prompts, sources, quotes, or model output.
- Server tests: `*.self-test.ts` with `node:assert/strict` (picked up by `npm run test:server`). Ported Lindevo tests stay `bun:test` files named `*.test.ts` under `server/src/engine/` and run through `bun test src/engine`, which Task 1 wires into `npm run test:server`.

## Decisions this plan makes inside the spec

- **Failures before a draft exists** (research, brief, draft) surface as a failed job on Runs with the reason, like a fast-mode failure. **Escalations after a draft exists** deliver the draft as a post and add a new action kind `engine_escalated` (blocker), so they reach the Review Queue through `classifyDraftAction`.
- **Similarity to existing posts** uses lexical 5-word shingle Jaccard over the site's posts (threshold `0.5`), not embeddings. `shortcut: lexical, upgrade to pgvector in sub-project 4 (novelty).`
- **Lindevo component lint** is not ported here: sub-project 1 drafts are plain Markdown and emit no Lindevo component tags. It moves to sub-project 7 (provenance box and components).
- Child tables (`article_stage_runs`, `article_sources`, `article_evidence`, `article_gate_results`) carry `user_id` and reach the site through `run_id`; only `article_runs` stores `site_id`. Every child query filters on `run_id` **and** `user_id`.
- Per-stage timing shows in a new `StageTimeline` on the Runs job detail; `RunWaterfall` stays the cross-job view.

## Review Focus

1. **A source page that is huge, binary, a PDF, or a paywall stub.** The reader must skip it (record status and `text_length`), never crash the stage or blow memory. → test in Task 5.
2. **A model reply that is not valid JSON or fails the stage schema.** One repair retry with the zod error, then a normal stage error (counts an attempt). → test in Task 4.
3. **Two workers claim the same run, or a lease expires mid-stage.** Only one commit lands; the loser's output is discarded without side effects. → test in Task 10.
4. **The post is edited, or the run's site is deleted, while a run is in flight.** The run never overwrites a human edit (optimistic `version` / post `updatedAt` check) and a deleted site fails the run cleanly. → test in Task 11.
5. **Non-English sources (Turkish ı/İ, Latvian ā/ķ, „low-9" quotes, guillemets).** Quote verification and overlap must match them. → test in Task 2.

---

### Task 1: Engine scaffold, `marked`, engine tests in the server suite

**Files:**
- Modify: `server/package.json` (add `"marked": "^18.0.14"`), `server/src/run-self-tests.ts`
- Create: `server/src/engine/types.ts`, `server/src/engine/config.ts`, `server/src/engine/README.md`
- Create: `server/src/engine/util.ts` (ported helpers), `server/src/engine/util.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type EngineMode = "normal" | "deep"`; `type GenerationMode = "fast" | EngineMode`
  - `type StageKey = "research" | "brief" | "draft" | "gates" | "revise" | "deliver"`
  - `type ModelRole = "research_queries" | "research_claims" | "brief" | "draft" | "revise"`
  - `type Transition = { type: "advance"; to: StageKey } | { type: "done" } | { type: "escalate"; reason: string } | { type: "wait"; to: StageKey; at: Date }`
  - `class RateLimitError extends Error { retryAfterMs?: number }`, `class StageInputError extends Error` (not retryable)
- Produces (`config.ts`): `ENGINE_CONFIG` with the Lindevo defaults the ported modules read: `evidence { minQuoteWords: 8, maxQuoteWords: 60, minRatio: 0.92, maxSourceAgeDays: 30, windowSlack }`, `gates { minWords, maxWords, targetWords, titleMax: 60, descriptionMax: 155, faqAnswerMin: 40, overlapMaxPercent: 5, similarityMax: 0.5 }`, `voice` (copy `LV/config/engine.ts` values; drop Lindevo-only service/pain-point fields). Type it as `EngineConfig`.
- Produces (`util.ts`): the `@acme/engine-kit/util` functions the ported modules import (`truncate`, `sanitizeText`, `mapLimit`, `sha256Hex`, `isBoilerplateTitle`) — copy only these, with their tests.

- [ ] **Step 1:** Add `marked` to `server/package.json` and run `npm install` from the repo root. Expected: lockfile updated, no peer warnings for `marked`.
- [ ] **Step 2:** Copy the five helpers and their `bun:test` cases from `~/Projects/lindevo/packages/engine-kit/src/{util,hash,boilerplate-title}.ts` and `*.test.ts` into `server/src/engine/util.ts` / `util.test.ts`, changing imports only.
- [ ] **Step 3:** Run `cd server && bun test src/engine`. Expected: PASS.
- [ ] **Step 4:** In `run-self-tests.ts`, after the self-test loop, spawn `[process.execPath, "test", "src/engine"]` with `cwd: join(repositoryRoot, "server")` and add `server/src/engine (bun test)` to `failures` on a non-zero exit.
- [ ] **Step 5:** Write `types.ts`, `config.ts` and a 10-line `README.md` (what `engine/` is, link to the spec, "ported from Lindevo; keep tests with code").
- [ ] **Step 6:** Run `npm run test:server` from the repo root. Expected: all self-tests pass, then `bun test src/engine` passes.
- [ ] **Step 7:** Commit `feat(engine): scaffold the staged engine module`.

### Task 2: Evidence verification and Markdown helpers (ported)

**Files:**
- Create: `server/src/engine/evidence/{normalize,verify}.ts` + `.test.ts` (from `LV/evidence/`)
- Create: `server/src/engine/markdown/{plain-text,faq,mask-code}.ts` + tests (from `MDX/lint/plain-text.ts`, `MDX/faq.ts`, `MDX/lib/mask-code.ts`)

**Interfaces:**
- Produces: `normalizeText(s: string): string`, `extractNumbers(s: string): string[]`, `levenshteinRatio(a, b): number`
- Produces: `verifyQuote(input: { claim: string; quote: string; page: { markdown: string; status: number; fetchedAt: Date }; now: Date; config: EngineConfig["evidence"] }): VerifyResult` — `VerifyResult = { verified: boolean; reason: VerifyReason | null; score: number | null; start: number | null; end: number | null }`, unchanged from Lindevo.
- Produces: `toPlainText(markdown: string): string`, `dropSourcesSection(markdown: string): string`, `scanFaq(markdown: string): FaqEntry[]`

- [ ] **Step 1:** Copy the source and test files. In `plain-text.ts`, remove the `component-spec` dependency: treat every HTML-like tag as markup to strip (no component allowlist).
- [ ] **Step 2:** Add a Review Focus test to `verify.test.ts`:

```ts
test("verifies Turkish and Latvian quotes with low-9 and guillemet marks", () => {
  const page = { markdown: "Uzņēmumu skaits pieauga par 12% 2025. gadā, liecina „Lursoft” dati par Latvijas tirgu un tā izaugsmi.", status: 200, fetchedAt: new Date("2026-11-01") };
  const r = verifyQuote({ claim: "Companies grew 12% in 2025.", quote: "Uzņēmumu skaits pieauga par 12% 2025. gadā, liecina \"Lursoft\" dati par Latvijas tirgu", page, now: new Date("2026-11-03"), config: ENGINE_CONFIG.evidence });
  expect(r.verified).toBe(true);
  const tr = verifyQuote({ claim: "İstanbul has 16 million residents.", quote: "İstanbul'un nüfusu 16 milyonu aştı ve şehir büyümeye devam ediyor", page: { ...page, markdown: "Son verilere göre İstanbul'un nüfusu 16 milyonu aştı ve şehir büyümeye devam ediyor." }, now: new Date("2026-11-03"), config: ENGINE_CONFIG.evidence });
  expect(tr.verified).toBe(true);
});
```

- [ ] **Step 3:** Run `cd server && bun test src/engine/evidence src/engine/markdown`. Expected: PASS. If the Latvian or Turkish case fails, fix `normalizeText` (case folding with `toLocaleLowerCase("und")` and quote-mark unification), not the test.
- [ ] **Step 4:** Commit `feat(engine): port quote verification and markdown helpers`.

### Task 3: Code gates and citation rendering (ported)

**Files:**
- Create: `server/src/engine/gates/{types,structure,meta,citations,overlap,voice,links,similarity,index}.ts` + tests (from `LV/gates/`, without `lint`, `keywords` and the embedding `similarity`)
- Create: `server/src/engine/citations.ts` + test (from `LV/stages/shared/citations.ts`)

**Interfaces:**
- Consumes: Task 2 helpers, `ENGINE_CONFIG`.
- Produces (`gates/types.ts`):
  - `GateResult = { gate: string; issues: GateIssue[]; passed: boolean; severity: "blocker" | "warning"; metrics?: Record<string, number> }`
  - `GateInput = { markdown: string; raw: string; title: string; description: string; evidence: EvidenceItem[]; sources: SourceItem[]; existingPosts: { id: string; title: string; content: string }[]; siteUrl: string }`
  - `EvidenceItem = { id: string; claim: string; quote: string; sourceId: string; verified: boolean }`; `SourceItem = { id: string; url: string; finalUrl: string; title: string | null; markdown: string }`
  - `gateBlockers(results: GateResult[]): { gate: string; message: string; excerpt?: string; fix?: string }[]`
- Produces (`gates/index.ts`): `runCodeGates(input: GateInput, deps: { config: EngineConfig; checkLink: (url: string, signal?: AbortSignal) => Promise<number>; signal?: AbortSignal }): Promise<GateResult[]>` — order: structure, meta, faq, voice, citations, links, overlap, similarity.
- Produces (`citations.ts`): `renderCitations(markdown: string, evidence: EvidenceItem[], sources: SourceItem[], style: "inline" | "references", locale: string): string`; `CITATION_MARKER_RE = /\{\{c:([A-Za-z0-9_-]+)\}\}/g`

- [ ] **Step 1:** Copy the gate files and their tests from `LV/gates/gates.test.ts`. Replace `CaseRow`/`EvidenceRow`/`SourceRow` with `GateInput`'s types; drop `cta` from `structureGate` (no service CTA outside Lindevo); `linksGate` uses `deps.checkLink` instead of the crawl client.
- [ ] **Step 2:** Write the new `similarity.ts` and its test:

```ts
test("similarity gate blocks a near-copy of an existing post and passes a new one", () => {
  const base = "Automating order emails into a spreadsheet saves small teams hours every week ".repeat(20);
  expect(similarityGate({ ...input, markdown: base, existingPosts: [{ id: "p1", title: "x", content: base }] }, ENGINE_CONFIG.gates).passed).toBe(false);
  expect(similarityGate({ ...input, markdown: "A completely different article about cooking pasta at home ".repeat(20), existingPosts: [{ id: "p1", title: "x", content: base }] }, ENGINE_CONFIG.gates).passed).toBe(true);
});
```

`similarityGate(input: GateInput, cfg: EngineConfig["gates"]): GateResult` computes Jaccard over 5-word shingles of `toPlainText`, blocker when max ≥ `cfg.similarityMax`; metric `maxSimilarity`. Add the `shortcut:` comment from "Decisions" above.
- [ ] **Step 3:** Copy `citations.ts` and the citation tests from `LV/stages/shared/*citations*.test.ts`. Add the `"inline"` style: each marker becomes `[host](url)` after the sentence instead of a superscript plus a Sources list. Headings for `references` come from a locale map with `en: "Sources"` and fall back to `"Sources"`.
- [ ] **Step 4:** Run `cd server && bun test src/engine/gates src/engine/citations.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): port code gates and citation rendering`.

### Task 4: Engine LLM client

**Files:**
- Create: `server/src/engine/adapters/llm.ts`, `server/src/engine/adapters/llm.self-test.ts`, `server/src/engine/adapters/fake-llm.ts`

**Interfaces:**
- Produces:
  - `type EngineLlm = { json<T>(req: { role: ModelRole; model: string; system: string; user: string; schema: z.ZodType<T>; maxTokens: number; signal?: AbortSignal }): Promise<{ value: T; model: string; promptTokens: number; completionTokens: number; costUsd: number }> }`
  - `engineAiEndpoint(env: Record<string, string | undefined>, openRouterKey: string | null): { baseUrl: string; apiKey: string; gateway: "openrouter" | "custom" } | null` — `null` when no key is available.
  - `createEngineLlm(endpoint, fetchImpl?: typeof fetch): EngineLlm`
  - `createFakeLlm(replies: Record<string, unknown[]>): EngineLlm` — replies keyed by role, consumed in order; records calls for assertions.

- [ ] **Step 1:** Write `llm.self-test.ts` with a stub `fetchImpl` covering:
  - `engineAiEndpoint({}, "sk-or")` → OpenRouter base URL, key `sk-or`, gateway `openrouter`.
  - `engineAiEndpoint({ ENGINE_AI_BASE_URL: "http://litellm:4000/v1", ENGINE_AI_API_KEY: "k" }, "sk-or")` → custom URL, key `k`.
  - `engineAiEndpoint({ ENGINE_AI_BASE_URL: "http://x/v1" }, "sk-or")` → `null` (override without its own key never sends the user's OpenRouter key elsewhere).
  - Cost: from `usage.cost` (OpenRouter) or the `x-litellm-response-cost` header; `0` when neither is present.
  - HTTP 429 → throws `RateLimitError` with `retryAfterMs` from `Retry-After`.
  - **Review Focus 2:** first reply `"not json"`, second reply valid → `value` is the parsed second reply and exactly 2 requests were sent; two invalid replies → throws a plain `Error` whose message names the schema failure.
- [ ] **Step 2:** Run `cd server && bun run src/engine/adapters/llm.self-test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Request: `POST {baseUrl}/chat/completions` with `response_format: { type: "json_schema", json_schema: { name: role, schema: z.toJSONSchema(schema), strict: true } }`, `usage: { include: true }`. The repair retry appends the zod issue list as a user message.
- [ ] **Step 4:** Run the self-test. Expected: `engine llm self-check passed`.
- [ ] **Step 5:** Commit `feat(engine): add the OpenAI-compatible engine LLM client`.

### Task 5: Search and page reader adapters

**Files:**
- Create: `server/src/engine/adapters/{search,reader}.ts` + `.self-test.ts`, `server/src/engine/adapters/fakes.ts`

**Interfaces:**
- Produces:
  - `type SearchHit = { url: string; title: string; snippet: string }`
  - `type SearchClient = { name: "searxng" | "dataforseo" | "none"; search(query: string, opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<SearchHit[]> }`
  - `createSearchClient(env, dataForSeo: DataForSeoClient | null, fetchImpl?): SearchClient` — SearXNG (`GET {SEARXNG_URL}/search?q=&format=json&language=`) when set; on SearXNG error falls back to `dataForSeo.serp`; `name: "none"` when neither is configured.
  - `type ReadPage = { url: string; finalUrl: string; status: number; title: string | null; markdown: string; fetchedVia: "crawl4ai" | "safe-fetch"; fetchedAt: Date }`
  - `type PageReader = { read(url: string, signal?: AbortSignal): Promise<ReadPage> }`
  - `createPageReader(env, deps?: { fetchImpl?: typeof fetch; safeFetch?: typeof safeFetch }): PageReader` — Crawl4AI `POST {CRAWL4AI_URL}/md` (`Authorization: Bearer {CRAWL4AI_TOKEN}` when set) first; on error or empty text, `safeFetch` + `extractMainText` from `internal-linking.ts`. Every URL passes `validatePublicUrl` before either reader.
  - `MAX_PAGE_BYTES = 2_000_000`, `MAX_PAGE_CHARS = 200_000`
  - `createFakeSearch(hits: Record<string, SearchHit[]>)`, `createFakeReader(pages: Record<string, Partial<ReadPage>>)` in `fakes.ts`.

- [ ] **Step 1:** Write the self-tests with stubbed fetches:
  - SearXNG configured and working → `name === "searxng"`; SearXNG throws → the DataForSEO fake is called; nothing configured → `name === "none"`.
  - Crawl4AI returns markdown → `fetchedVia === "crawl4ai"`; Crawl4AI 500 → `fetchedVia === "safe-fetch"`.
  - **Review Focus 1:** a `content-type: application/pdf` response, a 5 MB body and a 401 paywall all return a `ReadPage` with `markdown === ""` and the real `status`, and never throw.
  - `http://192.168.0.1/` is refused before any fetch.
- [ ] **Step 2:** Run both self-tests. Expected: FAIL.
- [ ] **Step 3:** Implement `search.ts`, `reader.ts`, `fakes.ts`.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): add search and page reader adapters with fallbacks`.

### Task 6: DataForSEO adapter (ported)

**Files:**
- Create: `server/src/engine/adapters/dataforseo.ts` + `dataforseo.test.ts` (from `LV/adapters/dataforseo.ts`)

**Interfaces:**
- Produces:
  - `type DataForSeoClient = { serp(query: string, opts: { locale: string; limit: number; signal?: AbortSignal }): Promise<SearchHit[]>; keywordOverview(keyword: string, opts: { locale: string; signal?: AbortSignal }): Promise<KeywordOverview | null>; peopleAlsoAsk(query: string, opts: { locale: string }): Promise<string[]> }`
  - `KeywordOverview = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; aiOverview: boolean }`
  - `createDataForSeoClient(env, deps: { fetchImpl?: typeof fetch; monthlySpentUsd: () => Promise<number>; recordSpend: (usd: number) => Promise<void> }): DataForSeoClient | null` — `null` without credentials. Over `DATAFORSEO_MONTHLY_USD`, calls return empty results and do not hit the network.
  - `localeMarket(locale: string): { locationCode: number; languageCode: string }` — `en → 2840/en`, `lv → 2428/lv`, `tr → 2792/tr`, else `2840/en`.

- [ ] **Step 1:** Copy the adapter and its tests. Remove Lindevo market weighting, the LV keyword localization and the sanitizer pre-check (sub-project 3). Keep cost booking, timeouts and response validation.
- [ ] **Step 2:** Add a test: with `monthlySpentUsd` returning `10` and `DATAFORSEO_MONTHLY_USD=10`, `keywordOverview` returns `null` and the fetch stub was not called.
- [ ] **Step 3:** Run `cd server && bun test src/engine/adapters/dataforseo.test.ts`. Expected: PASS.
- [ ] **Step 4:** Commit `feat(engine): port the DataForSEO adapter`.

### Task 7: Migration and Drizzle schema for article runs

**Files:**
- Create: `server/src/db/migrations/0037_article_runs.sql`
- Modify: `server/src/db/schema.ts` (append tables), `server/src/run-postgres-integration.ts`

**Interfaces:**
- Produces Drizzle tables `articleRuns`, `articleStageRuns`, `articleSources`, `articleEvidence`, `articleGateResults`, and a nullable `user_settings.engine_settings JSONB` column (`userSettings.engineSettings`).

SQL (columns are the contract; indexes as listed):

```sql
CREATE TABLE IF NOT EXISTS article_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  preferred_integration_id UUID REFERENCES site_integrations(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('normal','deep')),
  source_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  settings JSONB NOT NULL,            -- frozen preset + models + citation style at start
  current_stage TEXT NOT NULL DEFAULT 'research',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','waiting_human','done','failed','escalated')),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0,
  revise_count INTEGER NOT NULL DEFAULT 0,
  budget_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  state_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_runs_claim_idx ON article_runs (next_attempt_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS article_runs_user_site_idx ON article_runs (user_id, site_id, created_at DESC);
-- article_stage_runs: id, run_id → article_runs ON DELETE CASCADE, user_id, stage, attempt, status
--   ('running','succeeded','failed','reused'), input_hash, model, prompt_version, prompt_tokens, completion_tokens,
--   cost_usd REAL DEFAULT 0, output JSONB, error TEXT, started_at, finished_at; UNIQUE (run_id, stage, attempt);
--   INDEX (run_id, stage, input_hash) WHERE status = 'succeeded'
-- article_sources: id, run_id CASCADE, user_id, url, final_url, fetched_via, http_status, text_length, title, markdown TEXT, fetched_at
-- article_evidence: id, run_id CASCADE, user_id, source_id → article_sources CASCADE, claim, quote, kind, verified BOOLEAN,
--   method TEXT ('exact','windowed') NULL, ratio REAL NULL, reason TEXT NULL
-- article_gate_results: id, run_id CASCADE, user_id, attempt, gate, passed, severity, issues JSONB, metrics JSONB, created_at
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS engine_settings JSONB;
```

- [ ] **Step 1:** In `run-postgres-integration.ts`, after the existing migration checks, add: the five tables exist; inserting an `article_runs` row with `mode = 'fast'` fails the check constraint; deleting the owning user cascades to all five tables.
- [ ] **Step 2:** Write the migration and the Drizzle tables.
- [ ] **Step 3:** Run against a disposable database: `DATABASE_URL=… POSTGRES_INTEGRATION_ALLOW_WRITES=1 npm run test:postgres`. Expected: PASS, and the repeat-migration check still holds.
- [ ] **Step 4:** Commit `feat(db): add article run tables`.

### Task 8: Mode presets and engine settings

**Files:**
- Create: `server/src/engine/modes.ts`, `server/src/engine/modes.self-test.ts`

**Interfaces:**
- Produces:
  - `type ModePreset = { stages: StageKey[]; maxRevise: number; research: { maxQueries: number; maxPages: number; maxClaimsPerPage: number; minVerifiedClaims: 3; useKeywordData: boolean }; models: Record<ModelRole, string>; budgetUsd: number; estimateUsd: Record<StageKey, number> }`
  - `MODE_PRESETS: Record<EngineMode, ModePreset>`:
    - normal: all six stages; `maxRevise: 1`; research `{ maxQueries: 3, maxPages: 6, maxClaimsPerPage: 5, useKeywordData: false }`; `budgetUsd: 1`
    - deep: all six stages; `maxRevise: 2`; research `{ maxQueries: 6, maxPages: 12, maxClaimsPerPage: 6, useKeywordData: true }`; `budgetUsd: 5`
    - models: claim extraction and query planning `anthropic/claude-haiku-5.5` in both; writing roles `anthropic/claude-sonnet-5.5` (normal) and `anthropic/claude-opus-5.5` (deep). Ids are resolved at run start through `resolveOpenRouterTextModel`, which falls back when an id is unavailable.
  - `type EngineSettings = { models?: Partial<Record<ModelRole, string>>; budgetUsd?: number; citationStyle?: "inline" | "references" }`
  - `parseEngineSettings(value: unknown): EngineSettings` (invalid fields dropped)
  - `resolveRunSettings(mode: EngineMode, settings: EngineSettings): { preset: ModePreset; models: Record<ModelRole, string>; budgetUsd: number; citationStyle: "inline" | "references" }` — default citation style `"references"`.
  - `estimateRunUsd(mode: EngineMode): number` (sum of `estimateUsd`).

- [ ] **Step 1:** Self-test: deep has a larger `maxRevise` and `maxPages` than normal; `resolveRunSettings("normal", { models: { draft: "x/y" }, budgetUsd: 2 })` overrides only `draft` and the budget; `parseEngineSettings({ budgetUsd: -1, citationStyle: "footnotes" })` returns `{}`.
- [ ] **Step 2:** Run it. Expected: FAIL. Implement. Run again. Expected: PASS.
- [ ] **Step 3:** Commit `feat(engine): add normal and deep mode presets`.

### Task 9: Shared account guardrail check (extract from fast mode)

**Files:**
- Modify: `server/src/services/generate-content.ts:681-729`
- Create: `server/src/services/account-guardrails.ts`, `server/src/services/account-guardrails.self-test.ts`

**Interfaces:**
- Produces: `checkAccountGuardrails(userId: string, now?: Date): Promise<{ blocked: false } | { blocked: true; message: string; latchMonthly: boolean }>` — the monthly budget (with `budgetPaused` latch) and daily ceilings exactly as fast mode applies them today, via `evaluateDailyGuardrails`.

- [ ] **Step 1:** Self-test the pure part: extract `guardrailDecision(settings, usage)` and assert the existing messages ("Generation paused — monthly budget exceeded", the daily ceiling text) for each case.
- [ ] **Step 2:** Move the block out of `generateContent` into `checkAccountGuardrails`; `generateContent` keeps its job-failing writes and calls the helper.
- [ ] **Step 3:** Run `npm run test:server`. Expected: all pass, including `generation-guardrails.self-test.ts`.
- [ ] **Step 4:** Commit `refactor(generation): share the account guardrail check`.

### Task 10: Runtime — claim, lease, input-hash reuse, retries

**Files:**
- Create: `server/src/engine/runtime/{claim,advance,hash,deps,stage}.ts`, `server/src/engine/runtime/advance.self-test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7, 8, and `checkAccountGuardrails` from Task 9.
- Produces (`stage.ts`):
  - `type StageContext = { run: ArticleRunRow; deps: EngineDeps; signal: AbortSignal; attempt: number }`
  - `type StageOutcome<O> = { output: O; next: Transition; usage?: { model: string; promptTokens: number; completionTokens: number; costUsd: number }[] }`
  - `type Stage<I, O> = { key: StageKey; promptVersion: string; input(ctx: StageContext): Promise<I>; run(input: I, ctx: StageContext): Promise<StageOutcome<O>> }`
- Produces (`deps.ts`): `type EngineDeps = { llm: EngineLlm; search: SearchClient; reader: PageReader; dataForSeo: DataForSeoClient | null; now: () => Date; stages: Record<StageKey, Stage<unknown, unknown>> }`; `loadEngineDeps(run: ArticleRunRow): Promise<EngineDeps>`
- Produces (`hash.ts`): `stageInputHash(stage: StageKey, promptVersion: string, models: Record<ModelRole, string>, input: unknown): string` — sha256 of stable-key JSON.
- Produces (`claim.ts`): `claimArticleRuns(workerId: string, limit: number, now: Date, leaseMs = 20 * 60_000): Promise<ArticleRunRow[]>`

```sql
UPDATE article_runs SET lease_owner = $worker, lease_expires_at = $now + $lease, updated_at = $now
WHERE id IN (SELECT id FROM article_runs
  WHERE state = 'active' AND next_attempt_at <= $now AND (lease_expires_at IS NULL OR lease_expires_at < $now)
  ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $limit)
RETURNING *
```

- Produces (`advance.ts`): `advanceArticleRun(run: ArticleRunRow, deps: EngineDeps): Promise<{ kind: "advanced" | "reused" | "done" | "escalated" | "retry" | "failed" | "rate_limited" | "budget_paused" | "lease_lost"; stage: StageKey }>`
  - Reuse: a `succeeded` stage run with the same `(run_id, stage, input_hash)` → insert a `reused` row, apply its stored `{ next }`, no LLM calls.
  - Commit: one statement updates `article_runs` (stage, state, `version + 1`, `spent_usd`, clear lease) `WHERE id = $id AND user_id = $user AND lease_owner = $worker AND version = $version`; zero rows → `lease_lost` and the stage run is marked `failed` with `error = 'lease lost'`.
  - `RateLimitError` → `next_attempt_at = now + max(retryAfterMs, 60s)`, attempt not consumed.
  - Other errors → attempt 1 retries at +10 min, attempt 2 at +30 min, attempt 3 → `state = 'failed'`, `state_reason` = the error message truncated to 300 characters.
  - `StageInputError` → fail immediately.
  - Budget: before a stage, `spent_usd + preset.estimateUsd[stage] > budget_usd` → `budget_paused` (the run stays `active` with `next_attempt_at` = +1 h and `state_reason = "Run budget reached: $X of $Y spent"`). Then `checkAccountGuardrails` (Task 9) → same pause with its message.
  - Mirror to `jobs`: `current_step = engine_<stage>`; terminal states set `jobs.status` (`completed` for done/escalated with a post, `failed` otherwise), `completedAt`, `errorMessage`, `totalCost = spent_usd`.

- [ ] **Step 1:** Write `advance.self-test.ts` against the disposable database (skip with a log line when `POSTGRES_INTEGRATION_ALLOW_WRITES !== "1"`, like the other DB self-tests), using fake stages and fake adapters:
  - happy path advances research → brief with one `succeeded` row;
  - a second run with identical input reuses the output and the fake LLM records no call;
  - **Review Focus 3:** two `claimArticleRuns` calls racing (`Promise.all`) return disjoint sets; a run whose `version` changed before commit returns `lease_lost` and the `article_runs` row is unchanged;
  - 429 → `rate_limited`, `attempt` unchanged, `next_attempt_at` ≥ now + 60 s;
  - three thrown errors → `failed` with a `state_reason`;
  - budget 0.01 → `budget_paused`, nothing called;
  - tenant isolation: a run owned by user B is never returned to a claim scoped by `loadEngineDeps` of user A, and `advanceArticleRun` refuses a run whose `user_id` does not match its job's `user_id`.
- [ ] **Step 2:** Run with `POSTGRES_INTEGRATION_ALLOW_WRITES=1 DATABASE_URL=… bun run src/engine/runtime/advance.self-test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `claim.ts`, `hash.ts`, `advance.ts`, `stage.ts`, `deps.ts`.
- [ ] **Step 4:** Run it. Expected: `article run runtime self-check passed`.
- [ ] **Step 5:** Commit `feat(engine): add the leased, resumable stage runtime`.

### Task 11: Stages — research, brief, draft, gates, revise, deliver

**Files:**
- Create: `server/src/engine/stages/{research,brief,draft,gates,revise,deliver}/{index,schema}.ts`, ported `*.test.ts` for research, brief, draft, revise
- Create: `server/src/engine/prompts/{research-queries,research-claims,brief,draft,revise}.md`, `server/src/engine/prompts/partials/house-style.md`, `server/src/engine/prompts/load.ts`
- Create: `server/src/engine/stages/index.ts` (`STAGES: Record<StageKey, Stage<unknown, unknown>>`)

**Interfaces:**
- Consumes: Tasks 2–9, `buildVoiceContentInstructions` (`voice-content.ts`), `getEffectiveSettings` (brand fields, language), the internal link index on user settings.
- Produces (`prompts/load.ts`): `preparePrompt(name: string, vars: Record<string, string>): { system: string; user: string; version: string }` — reads front-matter `version`, splits on `<!-- system -->` / `<!-- user -->`, fences data with the Lindevo `DATA_RULE`.
- Stage contracts (each stage reads earlier outputs from `article_stage_runs`, latest `succeeded`/`reused` row per stage):
  - `research` → writes `article_sources` and `article_evidence`; output `{ queries: string[]; sourceIds: string[]; verifiedClaimIds: string[]; keyword: KeywordOverview | null; searchAdapter: SearchClient["name"] }`. Fewer than `minVerifiedClaims` verified → `{ type: "escalate", reason: "Not enough checkable sources: N verified claims from M pages" }`.
  - `brief` → `BriefSchema` ported from `LV/stages/brief/schema.ts` minus `service`, `painPoint`, `component plan` and cover fields; internal links chosen from the site's internal link index (`userSettings.internalLinkIndex`), never invented.
  - `draft` → `{ title: string; description: string; markdown: string; raw: string }`; `raw` keeps `{{c:id}}`, `markdown` is `renderCitations(raw, …, citationStyle, locale)`. Unknown claim ids are dropped, as in Lindevo.
  - `gates` → writes `article_gate_results`; all blockers pass → `advance deliver`; blockers and `revise_count < maxRevise` → `advance revise`; otherwise → `deliver` with `state_reason = "Gates still failing: …"` and the run ends `escalated`.
  - `revise` → same output shape as `draft`, increments `revise_count`; if the previous gate attempt had ≤ blockers than the one before, it stops early (→ `deliver`, escalated).
  - `deliver` → inserts the post (`sourceType` = run `source_type`, `modelId` = the draft model, `jobId`, `siteId`, `preferredIntegrationId`, `summary` = description, `publishingMetadata = { engine: { runId, mode, escalated: boolean } }`), creates revision 1 through the same helper `updatePostWithRevision` uses, sets `editorialState = "in_review"`, enqueues SEO metadata like fast mode (`enqueueSeoMetadata` + `kickSeoMetadataWorker`), writes one `generation_logs` row with the run's total cost. Then `done` (or `escalated`).

- [ ] **Step 1:** Copy the research, brief, draft and revise prompts and stage code. Remove Lindevo-only inputs (Notion, case-study, service CTA, pain points, sanitizer calls, LV locale) and replace repo calls with Drizzle queries filtered on `run.user_id` and `run.id`.
- [ ] **Step 2:** Port the stage tests, converting fixtures to `createFakeLlm` / `createFakeSearch` / `createFakeReader`.
- [ ] **Step 3:** Add `stages/e2e.test.ts`: a full normal run and a full deep run through `advanceArticleRun` with fakes only (no network) end with a post in `in_review` whose content contains a rendered citation and no `{{c:`. The deep run calls `dataForSeo.keywordOverview` once; the normal run never does.
- [ ] **Step 4:** Add the **Review Focus 4** tests in `stages/deliver`: (a) the site is deleted before `deliver` → the run ends `failed` with `state_reason = "Site no longer exists"` and no post is created; (b) delivery is idempotent: running `deliver` twice for one run creates one post (look up `posts` by `jobId` + `publishingMetadata->engine->runId` first).
- [ ] **Step 5:** Run `cd server && bun test src/engine`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(engine): port research, brief, draft, gates and revise stages`.

### Task 12: Start service, worker drain, operation events

**Files:**
- Create: `server/src/services/article-runs.ts`, `server/src/services/article-runs.self-test.ts`
- Modify: `server/src/services/background-worker.ts`, `server/src/services/background-worker.self-test.ts`

**Interfaces:**
- Produces:
  - `class EngineUnavailableError extends Error { code: "worker_required" | "ai_key_missing" }`
  - `engineAvailability(env?): { available: boolean; reason: string | null; adapters: { searxng: boolean; crawl4ai: boolean; dataforseo: boolean; gateway: "openrouter" | "custom" } }`
  - `startArticleRun(input: { userId: string; siteId: string; mode: EngineMode; sourceType: "article_keyword" | "article_title"; topic: string; preferredIntegrationId?: string | null; origin: "web" | "mcp" }): Promise<{ jobId: string; runId: string; estimateUsd: number }>` — inserts `jobs` (`status: "running"`, `currentStep: "engine_research"`, `generationPlan: { totalDrafts: 1, origin, engine: { mode } }`) and `article_runs` in one transaction with frozen `resolveRunSettings` output.
  - `drainArticleRuns(limit: number, workerId?: string): Promise<number>`
  - `getArticleRunForJob(userId: string, jobId: string): Promise<{ run: ArticleRunRow; stages: StageRunSummary[] } | null>` with `StageRunSummary = { stage: StageKey; attempt: number; status: string; model: string | null; costUsd: number; startedAt: string; finishedAt: string | null; error: string | null }`
- Worker: `BackgroundWorkerConfig.articleRuns` from `BACKGROUND_WORKER_ARTICLE_RUNS` (default `2`, bounded 1–10); `WorkerDrains.articles(limit)`; the drain name list becomes `["campaigns", "seo", "images", "articles"]`.
- Ledger: each stage transition calls `startOperationEvent` / `finishOperationEvent` with `origin: "system"`, action `engine.stage`, and metadata `{ run_id, stage, mode, status, cost_usd, duration_ms }` only.

- [ ] **Step 1:** Update `background-worker.self-test.ts`: default config includes `articleRuns: 2`; the cycle calls `articles:2`; a rejecting `articles` drain reports `failed: ["articles"]`.
- [ ] **Step 2:** Write `article-runs.self-test.ts`: `engineAvailability({})` → `{ available: false, reason: "worker_required" … }`; with `BACKGROUND_EXECUTION_MODE=worker` and nothing else → available, all adapters `false`, gateway `openrouter`. Assert `safeOperationMetadata("engine.stage", { prompt: "x", quote: "y", stage: "draft" })` keeps neither `prompt` nor `quote`.
- [ ] **Step 3:** Run both. Expected: FAIL. Implement. Run again. Expected: PASS.
- [ ] **Step 4:** Commit `feat(engine): start article runs and drain them in the worker`.

### Task 13: HTTP and MCP entry points

**Files:**
- Modify: `server/src/routes/content.ts` (`POST /generate`), `server/src/routes/jobs.ts` (`GET /:id`), `server/src/routes/settings.ts` (engine settings + availability)
- Modify: `server/src/mcp/tools.ts` (`generate_draft` input + handler), `server/src/mcp/tools.self-test.ts` or the nearest existing MCP self-test, `docs/mcp.md`

**Interfaces:**
- Consumes: Task 12.
- `POST /api/content/generate` accepts `mode: "fast" | "normal" | "deep"` (default `"fast"`). For normal/deep: requires `siteId`; `sourceType` must be `article_keyword` or `article_title` (else 400 `"Normal and deep modes support keyword and title sources"`); `EngineUnavailableError` → 409 with its message. Response `{ jobId, status: "running", postIds: [], mode, estimateUsd }`.
- `GET /api/jobs/:id` adds `engine: { mode, state, state_reason, spent_usd, budget_usd, stages: StageRunSummary[] } | null`.
- `GET /api/settings/engine` → `{ settings: EngineSettings; availability: ReturnType<typeof engineAvailability>; estimates: { normal: number; deep: number } }`; `PUT /api/settings/engine` validates with `parseEngineSettings` and stores `engine_settings` on the site settings row.
- MCP `generate_draft` input gains `mode: z.enum(["fast", "normal", "deep"]).default("fast")`. Normal/deep with `variations > 1` → `validation_error` ("Normal and deep modes create one draft per job."). `EngineUnavailableError` → `configuration_missing` with the reason. Output gains `mode`. The existing per-site `generation_busy` check applies to all modes.

- [ ] **Step 1:** Extend the MCP self-test: catalog still 22 tools; `generate_draft` schema accepts `mode: "deep"` and rejects `mode: "turbo"`; omitted `mode` parses as `"fast"`.
- [ ] **Step 2:** Run `npm run test:server`. Expected: the new assertions FAIL.
- [ ] **Step 3:** Implement the route and tool changes. Update `docs/mcp.md` with one paragraph on `mode`.
- [ ] **Step 4:** Run `npm run test:server` and `npm run test:mcp:pilot` (if its environment is available locally; otherwise note it skipped). Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): start normal and deep runs from web and MCP`.

### Task 14: Review packet Sources and the `engine_escalated` action

**Files:**
- Modify: `server/src/services/control-plane.ts`, `server/src/services/control-plane.self-test.ts`, `server/src/mcp/tools.ts` (`review_post` output schema), `web/src/lib/control-plane.ts`, `web/src/mcp-review/` (Sources block)

**Interfaces:**
- `ACTION_KINDS` gains `"engine_escalated"` placed first (it is a blocker). `DraftActionInput` gains `engineEscalation: string | null` (from `publishingMetadata.engine.escalated` + the run's `state_reason`); when set, reason `{ kind: "engine_escalated", severity: "blocker", label: "Engine checks", message: <state_reason> }`.
- `getReviewPacket` result gains `research: { mode: EngineMode; claims: { claim: string; quote: string; url: string; fetched_via: string; verified: boolean }[]; gates: { gate: string; passed: boolean; severity: string }[]; adapters: { search: string; keyword_data: boolean } } | null` — read through the post's `jobId` → `article_runs`, filtered by `user_id`. Verified claims first, at most 30.

- [ ] **Step 1:** Self-test: `classifyDraftAction({ …base, engineEscalation: "Gates still failing: overlap" })` returns severity `blocker`, kind `engine_escalated`, and that message; without it the existing ordering is unchanged.
- [ ] **Step 2:** Run. Expected: FAIL. Implement, including the `review_post` output schema and the Review Card "Sources" list (claim, quoted text, host link, reader badge). Run `npm run test:server` and `npm run test --workspace=web`. Expected: PASS.
- [ ] **Step 3:** Commit `feat(review): show verified sources and engine escalations`.

### Task 15: Web — mode choice, engine settings, stage timeline

**Files:**
- Modify: `web/src/pages/ContentCreator.tsx`, `web/src/pages/Settings.tsx` (Article Settings → Engine section), `web/src/pages/Jobs.tsx`, `web/src/lib/api.ts`
- Create: `web/src/components/content/GenerationModeSelect.tsx`, `web/src/components/runs/StageTimeline.tsx`, `web/src/components/runs/StageTimeline.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/settings/engine`, `POST /api/content/generate` with `mode`, `GET /api/jobs/:id` `engine`.
- `GenerationModeSelect({ value, onChange, availability, estimates, sourceType })`: Fast / Normal / Deep as a segmented control (existing shadcn-style primitive). Normal/deep are disabled with the availability reason when unavailable, or when `sourceType` is not `article_keyword`/`article_title`. Under the control: `≈ $0.40 estimated` and `SearXNG ✓ · Crawl4AI ✓ · DataForSEO —`.
- `StageTimeline({ stages })`: one row per stage attempt — stage label, status tone (reuse `statusTone` colours from `RunWaterfall`), model, `$cost`, duration, attempt number, and error text for failed rows.
- Engine settings: model per role (`LiveTextModelSelect`), per-run budget (number), citation style (inline / reference list).
- Copy follows `docs/design-system/CONTENT.md`; keep the Device Console look.

- [ ] **Step 1:** `StageTimeline.test.tsx`: renders 3 rows for 3 stage runs, shows `$0.12` for `costUsd: 0.12`, and shows the error text for a failed row.
- [ ] **Step 2:** Run `npm run test --workspace=web -- StageTimeline`. Expected: FAIL. Implement the components and wire them in. Run again. Expected: PASS.
- [ ] **Step 3:** Run the full web lint, `npm run typecheck`, `npm run test --workspace=web` and `npm run build`. Expected: all pass.
- [ ] **Step 4:** Commit `feat(web): choose generation mode and inspect engine stages`.

### Task 16: Optional `publish_at` on CMS draft delivery

**Files:**
- Modify: `server/src/services/publishing.ts` (`PublishOptions`, `lindevoArticleArgs`), `server/src/services/publishing.self-test.ts`, `server/src/mcp/tools.ts` (`push_to_cms_draft`), the web push route, `docs/mcp.md`

**Interfaces:**
- `PublishOptions.publishAt?: Date`; `lindevoArticleArgs` gains a fifth parameter `publishAt?: Date`. Only the `lindevo` provider forwards it, as `publishAt: iso` in `create_article`/`update_article` args, and only when set. Other providers ignore it and the result carries `warnings: ["This destination does not support scheduled publishing; the draft has no publish date."]`.
- MCP `push_to_cms_draft` gains optional `publish_at: z.iso.datetime()` that must be in the future (else `validation_error`). Idempotency keys are unchanged.

- [ ] **Step 1:** Self-test: `lindevoArticleArgs(article, "news", undefined, new Map(), new Date("2026-12-01T08:00:00Z")).publishAt === "2026-12-01T08:00:00.000Z"`; without a date there is no `publishAt` key at all (so today's Lindevo CMS keeps accepting the call).
- [ ] **Step 2:** Run. Expected: FAIL. Implement. Run `npm run test:server`. Expected: PASS.
- [ ] **Step 3:** Commit `feat(publishing): pass an optional publish date to Lindevo drafts`.

### Task 17: Eval harness

**Files:**
- Create: `server/src/engine/evals/{schema,run,decide,cli}.ts` + `run.test.ts`, `decide.test.ts` (from `LV/evals/`, `LV/jobs/eval.ts`)
- Create: `server/src/engine/prompts/{judge-rubric,judge-pairwise}.md`
- Create: `server/src/engine/evals/briefs/*.json` — the 10 Lindevo briefs plus at least 3 new ones: `11-tr-local-dentist.json` (Turkish, local business), `12-shop-running-shoes.json` (e-commerce), `13-app-habit-tracker.json` (mobile app site)
- Modify: `server/package.json` (`"eval:engine": "bun run src/engine/evals/cli.ts"`), root `package.json` (`"eval:engine": "npm run eval:engine --workspace=server"`), `.gitignore` (`server/.eval/`)

**Interfaces:**
- `EvalBrief` (ported schema) = topic, locale, frozen `sources` (url, title, markdown) and `evidence`. No network during an eval.
- `cli.ts` flags: `--mode normal|deep|fast` (repeatable; first is the baseline), `--briefs <glob>`, `--judge-model <id>`, `--out <path>` (default `server/.eval/<timestamp>.json`), and `--record-brief "<topic>" --locale <code>`, which runs the real research stage once and writes a new frozen brief file instead of evaluating. Endpoint from `engineAiEndpoint(process.env, process.env.OPENROUTER_API_KEY ?? null)`.
- Report: per brief and mode, the rubric scores (accuracy, clarity, specificity, …), pairwise wins against the baseline, gate pass counts, cost; a summary line `normal vs fast: W-L-T`.
- `fast` runs call `generateArticleForEval(brief, model)`, a thin wrapper that sends the same writer prompt fast mode uses (`buildWriterSystemPrompt` + the draft user message) without touching the database.

- [ ] **Step 1:** Port `decide.ts` and the tests that do not need a model (the win/loss rules). Run `bun test src/engine/evals`. Expected: PASS.
- [ ] **Step 2:** Port `run.ts` with the fake LLM; test that one brief × two modes produces a report with both modes and a pairwise result.
- [ ] **Step 3:** Write the three new briefs by running the research stage once against real sources (`bun run src/engine/evals/cli.ts --record-brief "<topic>" --locale tr`), then reviewing the frozen evidence by hand.
- [ ] **Step 4:** Run a real eval: `npm run eval:engine -- --mode fast --mode normal --mode deep`. Expected: a report file and a summary line. Paste the summary into the PR description.
- [ ] **Step 5:** Commit `feat(engine): add the generation eval harness`.

### Task 18: Docs and release checks

**Files:**
- Modify: `docs/architecture.md` (engine section), `docs/self-hosting.md` (worker mode + the five adapter variables), `docs/operations.md` (the `articles` drain and how to read a stuck run), `FEATURE_PLAN.md` (add unchecked items for the remaining sub-projects and a checked item for this one), `server/.env.example` if present

- [ ] **Step 1:** Write the doc changes. Mark "normal as the default manual mode" as an **unchecked** item: it flips only after the eval shows normal beating fast (spec decision).
- [ ] **Step 2:** Run the full verification: `git diff --check`, full web lint, `npm run typecheck`, `npm run test:server`, `npm run test --workspace=web`, `npm run test:postgres` on a disposable database, `npm run build`. Expected: all pass.
- [ ] **Step 3:** Commit `docs: document the staged engine, its adapters and worker requirement`.
