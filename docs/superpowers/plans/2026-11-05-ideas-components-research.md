# Ideas, Lindevo components, deeper research and scheduling: implementation plan

**Spec:** `docs/superpowers/specs/2026-11-05-ideas-components-research-design.md`. It is the source of truth; read the sections your task names.

**Branch:** `feat/ideas-mdx-scheduling`.

## Rules for every task

- Every database query and mutation is scoped to the user (and to the site where relevant).
- Migrations are additive raw SQL in `server/src/db/migrations/`, mirrored in `server/src/db/schema.ts`. Apply them to the dev DB (`npm run db:migrate` from the repo root) and to the test DB. The test DB URL is `server/.env` `DATABASE_URL` with `/blogfactory` replaced by `/blogfactory_engine_test`; set `POSTGRES_INTEGRATION_ALLOW_WRITES=1` and run the same migrate command with that `DATABASE_URL`. Never write tests to `blogfactory`.
- **Tests:**
  - Engine code uses `bun:test` under `server/src/engine`.
  - Other server code uses `*.self-test.ts`, picked up by `npm run test:server`. Two tests failed before this work (`routes/auth.self-test.ts` and `services/search-console.self-test.ts`); no new failures are allowed.
  - Web uses vitest with the `createRoot` + `act` pattern; see `web/src/components/posts/CoverPanel.test.tsx`. Testing Library is not installed. Nine web test files failed before this work; no new failures are allowed.
- **Checks:**
  - server: `npx tsc -p server --noEmit`
  - web: `npm run typecheck`
  - `npm run build`
  - eslint on the web files you changed
- **The engine's patterns:**
  - Stages live in `server/src/engine/stages/*`.
  - Prompts are versioned `.md` files under `server/src/engine/prompts/`, filled with `preparePrompt`. Untrusted text goes through `fenceData` and `DATA_RULE`.
  - Model calls use `ctx.deps.llm.json` with zod schemas.
  - Fakes are in `server/src/engine/adapters/fake-*.ts`.
  - The run view (`server/src/engine/run-view.ts` and `web/src/components/runs/EngineRunView.tsx`) shows stage details.
- **The product boundary** (AGENTS.md):
  - Delivery is draft-only.
  - Don't add MCP tools or change the 22-tool catalog.
  - The web UI follows `UI_UX.md` and `docs/design-system/` (BywordCard, SectionHeader, compact, calm).
- Keep diffs focused and match the surrounding code. Commit once per task, with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.
- **Your report:** files changed; the exact API or response shapes later tasks depend on; the commands run, with results; and any deviations or doubts.

## Task 1: Lindevo components (spec section A)

1. **Vendor the linter.** Copy the lint from `/home/nauris/Projects/lindevo/packages/mdx/src` into `server/src/engine/components/`:
   - `component-spec.ts`, `lint.ts`, `lint/{structure,body,headings,faq-rules,parity,issue,plain-text}.ts`, `lib/{tags,mask-code,heading}.ts`, `faq.ts`;
   - `OPEN_RE` and `CONTAINER_TAGS` from `plugins/containers.ts`. Drop its `marked` type import.
   Add a header comment to each file saying it is vendored from Lindevo `packages/mdx`, with the date, and that changes should be kept in sync. Fix import paths only; leave the logic alone.
2. **Port the tests.** Convert the most important cases of Lindevo `lint.test.ts`, plus fixtures if needed, into a `bun:test` file. Cover at least one case per rule id.
3. **`guide.ts`.** `componentGuide(tags)` is ported from `/home/nauris/Projects/lindevo/apps/content-engine/src/prompts/components.ts`, using the engine tag set from the spec. `serviceCtaTag(service, painPoint)` builds the CTA tag.
4. **`profile.ts`.** At run start (`server/src/engine/article-runs.ts` `startArticleRun`), freeze `destinationProvider` into the run settings: the provider of `preferredIntegrationId`, or the site's single connected destination when there is exactly one, otherwise null. `componentProfile(run)` returns `"lindevo" | "markdown"`.
5. **Prompts.** The brief, draft and revise prompts get `{{components}}`.
   - The brief schema gains optional `service` and `painPoint` (the Lindevo enums or `"none"`), required in the Lindevo profile. Validate them in `validateBrief`.
   - Draft and revise get `{{serviceCta}}` (an empty string when `"none"`) and the Lindevo placement rules (spec A).
   - Bump the prompt versions per the prompt conventions in `server/src/engine/prompts/`.
6. **Gate `components`.** It runs only in the Lindevo profile. Each lint error becomes a blocker that names the rule and the line, and the structure checks from spec A run too. Add it to the gate list and to `GATES` labels in `web/src/components/runs/EngineRunView.tsx` ("Lindevo components").
7. **Provenance.** Deliver appends `<provenance …>` for the Lindevo profile. Add a `provenanceTag()` builder. Check that `renderArticle` still converts citations, and that Lindevo's `splitSourcesSection` keeps the Sources section valid.
8. **Preview.** In `web/src/pages/PostPreviewPage.tsx` (find the markdown renderer it uses), render the component tags as simple labelled blocks (spec A) instead of raw text. Keep it small; no new dependency.
9. **Tests:**
   - the profile;
   - the gate on good and bad Lindevo markdown;
   - the provenance builder;
   - brief validation of the service;
   - the prompt contains the guide only for the Lindevo profile.
   Update the existing engine tests and fakes. `bun test src/engine` must stay green.

## Task 2: deeper research (spec section B)

1. Migration `0039_article_sources_kind.sql`: `article_sources.kind TEXT NOT NULL DEFAULT 'evidence'`.
2. **Research stage.** Add a competitor step after search:
   - pick the top 3–5 organic results, skipping the run's site domain;
   - read each with `ctx.deps.reader` (same security checks);
   - extract the H2/H3 outline, word count and title in a pure function, `competitorOutline(markdown)`, which needs a test;
   - store `kind='competitor'` rows. Evidence extraction stays limited to evidence sources.
3. **Questions.** Get People also ask from `ctx.deps.dataForSeo.peopleAlsoAsk` in deep mode (when available). In all modes, collect questions from SERP titles and snippets that end with "?".
4. **`serpAnalysis`.** A new prompt `serp-analysis.md` and a zod schema produce it per the spec. One model call, using the `research_claims` model role (or add a role if the mode presets support it cleanly). Store it in the research output, and record the competitor count.
5. **Brief prompt.** Add the analysis (fenced as data) and the instructions from spec B. A target length from `typicalLength` feeds `fitLengthPlan` within `PLAN.limits`.
6. **Run view.** `stageDetails("research")` includes the competitors (title, url, outline, words), the gaps, the information gain and the questions. `EngineRunView` shows a "Competitors" block in the Research body.
7. **Tests:** the outline extraction, the analysis schema, and that the research output includes the analysis (with fakes). Update fakes and the e2e test.

## Task 3: ideas backend, data and discovery (spec section C: data model and discovery pipeline)

1. **Migration `0040_ideas.sql`:**
   - the `ideas` and `idea_discoveries` tables, plus `posts.publish_at timestamptz`;
   - indexes on `ideas (user_id, site_id, status)`, `ideas (site_id, scheduled_for)` and `idea_discoveries (status, created_at)`.
2. **`server/src/services/ideas/`:**
   - `settings.ts`: read and normalize `idea_settings`, stored in the site settings JSON (find how `engineSettings` is stored per site and do the same);
   - `signals.ts`: the collectors. Each takes injected deps (the search client, DataForSEO, a fetch function, and the db readers), so tests can fake them;
   - `novelty.ts`: word-overlap similarity;
   - `score.ts`: the factors and the geometric mean;
   - `candidates.ts`: the model call, using a new prompt under `server/src/engine/prompts/ideas-candidates.md` and the engine LLM client (`createEngineLlm` with the user's endpoint, as `loadEngineDeps` does);
   - `discovery.ts`: `runDiscovery(discoveryId)` and `drainIdeaDiscoveries(limit)`, which claim with `SKIP LOCKED`.
3. **Worker.** Add `ideas` to the drains (`server/src/services/background-worker.ts`). It drains discoveries; Task 4 adds the due-start step.
4. **Tests** (bun or self-test):
   - novelty;
   - score, including the zero factor and the demand cap;
   - each collector against fakes;
   - candidate schema validation;
   - a discovery end to end against the test DB, with fake deps, persisting ideas, skipping duplicates and dropping near-duplicates of posts.

## Task 4: ideas lifecycle, scheduling and API (spec section C: lifecycle and API)

1. **`server/src/services/ideas/schedule.ts`:**
   - cadence slots in the site timezone, with DST handled through `Intl`. Write a small helper; no new dependency;
   - `nextFreeSlot`;
   - `bookIdea`, which never double-books (use a unique index or a transactional check);
   - `startDueIdeas(now)`, which starts the article run through `startArticleRun` with guidance and cover, and sets `in_progress` and `job_id`.
2. **Delivery hook.** When the engine deliver stage creates a post from a run linked to an idea (`ideas.job_id = run.job_id`), set `ideas.post_id`, set the status to `drafted`, and set `posts.publish_at = ideas.scheduled_for`. A run that fails terminally (`mirrorJob`) returns the idea to `scheduled` with the error.
3. **Routes** in `server/src/routes/ideas.ts`, registered in `server/src/index.ts`: every endpoint in spec C, plus manual idea scoring and the autopilot step inside discovery. Settings live at `GET` and `PUT /api/settings/ideas`.
4. **Send to CMS.** Pre-fill `publish_at`: return `publish_at` in the post API, and have `web/src/components/posts/PublishDialog.tsx` use it as the default for Lindevo.
5. **Worker.** Add `startDueIdeas` to the `ideas` drain.
6. **Tests:**
   - slot generation, including weekdays, timezone and DST;
   - no double booking;
   - due start with a fake `startArticleRun`;
   - the lifecycle against the test DB;
   - tenant checks on every route, using the pattern in `server/src/routes/cover-routes.self-test.ts`.

## Task 5: the Ideas web app (spec section C: web)

1. Add the `/ideas` route and the "Ideas" sidebar item (Operate, between Create Content and Review Queue), with the tabs Inbox, Planned, Calendar and Settings. Use the existing `SectionTabs` and the patterns in `web/src/App.tsx`. Add a `web/src/lib/api.ts` type for ideas.
2. **Inbox cards** per spec: score, factor bars with labels, keyword data, refresh badge, angle, why now, outline, information gain, sources and actions. The Edit dialog edits the title, angle, keyword and mode. Approve with a date (default: next slot, from the calendar endpoint). Write now, and Reject with a reason.
3. **Discover ideas** button, with polling of the discovery status and "last run" with its cost.
4. **Planned list** with status and links (Runs, editor).
5. **Calendar:** a month grid, slots with the idea or draft, and reschedule through a date picker. Use plain CSS grid; no new dependency.
6. **Settings form** for the idea settings.
7. **Create Content:** add the "Discover ideas" link.
8. **Tests:** cards render the breakdown, approve calls the API, and the calendar renders the slots. Then the typecheck, lint, tests and build.

## Task 6: real run on the dev server, docs and the PR (the controller does this)

- A discovery on the dev Lindevo site.
- Approve an idea and Write now in normal mode to the Lindevo destination.
- Check: the components lint is clean, provenance is present, the competitor analysis shows in Runs, `publish_at` is set and pre-filled.
- Update `README.md`, `docs/architecture.md`, `docs/operations.md` and `AGENTS.md` (the IA list).
- Open the PR.
