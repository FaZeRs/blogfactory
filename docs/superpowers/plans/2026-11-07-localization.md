# Localization: implementation plan

This plan implements `docs/superpowers/specs/2026-11-07-localization-design.md`; read it first, since it is the source of truth for behaviour. Lindevo's reference implementation is in `/home/nauris/Projects/lindevo/apps/content-engine/`. It is read-only: port the logic, never edit it. The relevant files are `src/stages/localize/` (`index.ts`, `schema.ts`, `patch.ts`, `repeat.ts`, `links.ts`, `editor-lv.ts`), `src/search/lv-keyword.ts`, `prompts/localize.md`, `prompts/localize-review.md`, `prompts/localize-keyword.md`, `prompts/partials/latvian-style.md`, `lv/glossary.json` and `vendor/translating-english-to-latvian.md`. Work on branch `feat/localization`.

## Rules for every task

- Every database query and mutation is scoped to the user (and to the site where relevant). Never write tests to the `blogfactory` DB. The test DB is `server/.env` `DATABASE_URL` with `/blogfactory` replaced by `/blogfactory_engine_test`, used with `POSTGRES_INTEGRATION_ALLOW_WRITES=1`.
- **Tests:**
  - Engine code uses `bun:test` under `server/src/engine` (`bun test src/engine` from `server/`).
  - Other server code uses `*.self-test.ts`, run by `npm run test:server`. `routes/auth.self-test.ts` and `services/search-console.self-test.ts` failed before this work; no new failures are allowed.
  - Web uses vitest with the `createRoot` + `act` pattern. Run it as `NODE_OPTIONS=--no-webstorage npm run test --workspace=web`, which passes all files today.
- **Checks:** `npx tsc -p server --noEmit`, `npm run typecheck`, `npm run build`, and eslint on the web files you change.
- **The engine's patterns:**
  - Stages live in `server/src/engine/stages/*` and are registered in `stages/index.ts`. Transitions go through `runtime/advance.ts`.
  - Prompts are versioned `.md` files under `server/src/engine/prompts/`, filled with `preparePrompt`. Untrusted text goes through `fenceData` and `DATA_RULE`. Bump a prompt's `version` when you change it.
  - Model calls use `ctx.deps.llm.json` with zod schemas. The fake is `adapters/fake-llm.ts`.
  - Code gates live in `engine/gates/`, with results via `gateResult`. Gate labels for the run view are in `GATES` in `web/src/components/runs/EngineRunView.tsx`.
- **Product boundary:** draft-only, and no new MCP tools or scopes. Models, prompts and answers never enter the operation ledger.
- **Real model calls:** none in tests.
- **Commits:** keep diffs focused and match the surrounding code. Commit once per task, adding only your own files (`git add <files>`; retry on `index.lock`, because another agent may commit in parallel). End the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.
- **Report:** the files changed, the exact shapes later work depends on, the commands run with their results, and any deviations.

## Task A: review stage and style gate (engine)

1. **`style` code gate** (`engine/gates/style.ts`), added to `runCodeGates` after `voice`:
   - It uses a list of machine-sounding phrases. Seed it with at least 25, matched case-insensitively and word-bounded, on the rendered article text without code blocks or URLs. Examples: "delve", "in today's fast-paced", "it's important to note", "it is worth noting", "unlock the power", "navigate the complexities", "tapestry", "game-changer", "in the realm of", "a testament to", "embark on", "elevate your", "seamlessly", "robust solution", "ever-evolving", "harness the power", "dive into", "at the end of the day", "in conclusion", "furthermore,", "moreover,".
   - It also counts em dashes per 1,000 words.
   - It is a blocker when there are 3 or more phrase hits, or more than 6 em dashes per 1,000 words. Each hit is an issue with an excerpt (the sentence, at most 160 characters) and a fix hint.
- **Next migration number:** 0045.
- **Subscription models:** any model role can name a subscription model (`claude-code:` or `codex:`). Callers must create their LLM client with `userEngineLlm` (`services/engine-llm.ts`), never with `createEngineLlm` directly.

## Task A: data, settings, localization core and the engine stage (server)

1. **Migration 0045** creates `post_translations`, exactly as in the spec (with a unique index on `(post_id, locale)` and an index on `(user_id, site_id)`), and adds `user_settings.localization jsonb`. Mirror both in `schema.ts`. Apply the migration to the dev and test DBs.
2. **`services/localization/settings.ts`:**
   - `normalizeLocalization(raw)` never throws.
   - A locale code is `^[a-z]{2}(-[A-Z]{2})?$`; the name is at most 40 characters.
   - The glossary holds at most 200 `{source, target, note?}` entries, each field capped.
   - The style guide is capped at 20,000 characters.
   - `formalAddress.forbidden` holds at most 40 words.
   - At most 3 locales.
   - Add `getLocalization` and `saveLocalization`.
   - Routes: `GET`/`PUT /api/settings/localization?siteId`, following the `/settings/ideas` pattern.
3. **Model roles** `localize` and `localize_review`, added in `modes.ts`, `MODEL_ROLES` and the web `EngineSettingsCard` role list. Their defaults are the writer model and the mode's review model.
4. **Prompts** in `server/src/engine/prompts/`: `localize.md`, `localize-review.md` and `localize-keyword.md`, ported and made site-neutral, per the spec. Variables are filled with `preparePrompt`; untrusted text goes through `fenceData`. Translate modes: `new`, `revision` (the previous attempt plus its problems) and `update` (the existing translation as the base, plus a summary of what changed in the English).
5. **`services/localization/checks.ts`** (pure functions, each with tests):
   - Parity: the same components (use `lintParity` when the run profile is Lindevo; otherwise compare the counts of H2s, lists and blockquotes).
   - Citations: the same external URLs and numbered marks in order, with exactly one localized Sources list holding the same destinations.
   - Meta limits and slug rules.
   - FAQ.
   - Formal address, from the locale settings.
   - The repeat check (`repeat.ts` logic, a warning).
   - The site's banned words and phrases, through `withSiteVoice` and `voiceGate` on the translation.
6. **`services/localization/patch.ts`:** port Lindevo's `patch.ts` rules exactly. A fix applies only when the excerpt occurs once, on word boundaries, outside protected spans, and keeps the markup characters. Include tests.
7. **`services/localization/links.ts`:** rewrite `/blog/<en-slug>` links to `/<locale>/blog/<translated-slug>`, using the site's `post_translations` (slug matched through `posts.slug`, or however posts store slugs; check). Unknown links are left alone. Include tests.
8. **`services/localization/keyword.ts`:** port `lv-keyword.ts`, using `DataForSeoClient.keywordOverview` with the target locale, and skip quietly on any failure.
9. **`services/localization/localize.ts`:** `localizeArticle({ userId, siteId, locale, source: {title, description, markdown, imageAlt, keyword?}, base?: existing translation, deps })`:
   - **Flow:** keyword, then translate, then check, then review, then patch and re-check, then up to 2 revisions; keep the last passing attempt.
   - **Returns** `{ status: "ready" | "needs_review", translation: {title, slug, description, content, imageAlt, keyword}, findings, costUsd }`.
   - **LLM:** `userEngineLlm`, with the models resolved from the site's engine settings for the two roles.
   - Log spend to `generation_logs` and write one sanitized operation event, `posts.localize`, with counts and cost only.
10. **Engine stage `localize`:**
    - After the run passes gates (and review, when the mode has it), go to `localize` before `deliver` when the site has localization enabled; otherwise go straight to `deliver`.
    - The stage runs `localizeArticle` for each enabled locale and stores the results in its stage output.
    - A failure never fails the run: the output records the error and the run goes to `deliver`.
    - `deliver` writes `post_translations` rows for the new post, with `source_revision_id` set to the revision deliver created. Find how deliver creates the post and revision.
    - Add the stage to the run view labels (server `run-view.ts` and web `EngineRunView`), and to the eval harness only if that's trivial (it's optional).
11. **On-demand:** `translatePost(userId, postId, locale)` loads the post's current revision. It uses update mode when a translation exists, keeping `edited` wording. It upserts `post_translations` under a per-post-and-locale running guard (a `status: "running"` row or an in-memory lock; choose the simplest correct option and explain it).
12. **Tests:**
    - all pure functions;
    - the stage with a fake LLM: pass, patch-then-pass, revision, last-passing kept, failure means `needs_review` and the English still delivers, and update mode;
    - `translatePost` on the test DB.

## Task B: delivery, API and UI

1. **Routes**, in `routes/post-translations.ts`, mounted under `/api/posts`, scoped by user and site:
   - `GET /:id/translations` returns `[{locale, status, stale, title, slug, description, content, imageAlt, keyword, findings, updatedAt}]`. `stale` means `source_revision_id` differs from the post's current revision.
   - `PUT /:id/translations/:locale` takes `{title, slug, description, content, imageAlt, expectedUpdatedAt}`. It returns 409 on a stale `expectedUpdatedAt`, sets the status to `edited`, and validates the slug and limits.
   - `POST /:id/translations/:locale/run` starts `translatePost` detached. It needs the persistent worker host (`BACKGROUND_EXECUTION_MODE=worker`; copy the AI-visibility `/run` pattern), returns 202, and returns 409 if a translation is already running.
   - Include a self-test covering tenant scope, the 409s, the stale flag, and the status after an edit.
2. **Lindevo delivery:**
   - In `services/publishing.ts`, `publishLindevo` adds `lv: {title, slug, description, content, imageAlt}` when the post has an `lv` translation that is `ready` or `edited` and not stale. Pass it through `ArticlePayload`; find where the payload is built for a post and keep the change minimal.
   - Inline image URLs inside the translated content go through the same `replaceImageUrls` mapping.
   - A slug conflict on the `lv` slug retries with `-2`…`-6`, only if Lindevo returns a recognisable conflict error; check the existing error handling.
   - Test `lindevoArticleArgs` with and without `lv`.
3. **MCP:** `get_post` gains a read-only `translations` summary of `[{locale, status, stale, title, slug}]`. There is no new tool, and the catalog count is unchanged.
4. **Web:**
   - **Post editor** (`/library/posts/:id/edit`): a compact language switcher (English plus the site's enabled locales) above the editor.
     - A locale view shows the translation's title, slug, description and content in the same editor components (or the simplest existing equivalent), and saves through the PUT route with optimistic locking.
     - It shows status badges (Ready, Needs review with the findings listed, Edited, Stale) and a **Translate** or **Update translation** button that calls `/run` and polls until done.
     - If no locales are enabled, it shows nothing.
   - **Article Settings → Localization card:**
     - an enable switch;
     - locales (code and name);
     - per-locale glossary rows (source, target, note), a style guide textarea, and forbidden informal forms.
     - It saves through `/api/settings/localization`.
   - Include vitest for the switcher states and the settings card.
5. Checks as in the rules.
