# Quality loop: implementation plan

This plan implements `docs/superpowers/specs/2026-11-06-quality-loop-design.md`; read it first, since it is the source of truth for behaviour. Work on branch `feat/quality-loop`.

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
   - Add tests, and add the label "Style" to `GATES`.
2. **Model role `review`:**
   - Add it to `ModelRole` and `MODEL_ROLES` (`modes.ts`).
   - The default is the mode's writer model. Site engine settings can override it like the other roles: check `parseEngineSettings` and the web `EngineSettingsCard` role list, and add a "Review" row there.
3. **Presets:** add a `review` stage key and a `review: ("factcheck" | "reader")[]` field to `ModePreset`. Normal is `["factcheck"]`, deep is `["factcheck", "reader"]`. Add `estimateUsd.review` (normal 0.02, deep 0.15). Insert `review` into `STAGES` after `gates`.
4. **Prompts:**
   - `prompts/review-factcheck.md` is adversarial. It takes the draft (with `{{c:id}}` markers) and the evidence (id, claim and quote) as fenced data. It returns `{issues:[{kind:"unsupported"|"overstated"|"uncited_fact"|"contradiction", excerpt, claimId?, fix}]}` with at most 12 issues. The excerpt is copied exactly from the draft, under 200 characters.
   - `prompts/review-reader.md` reads as the brief's audience, given the angle, primary keyword, FAQ questions and outline purposes. It returns `{issues:[{kind:"unclear"|"missing_step"|"unanswered_question"|"padding"|"jargon", excerpt, fix}]}` with at most 6 issues.
5. **`stages/review/index.ts`:**
   - **Input:** the latest draft, the brief, the evidence (verified, with quotes) and the site context. Copy how `revise` loads its context.
   - **Run:** one call per enabled check (role `review`, run in parallel).
   - **Excerpt filter:** drop any issue whose excerpt isn't found in the raw draft after normalizing whitespace, quotes and dashes and lowercasing. Count the drops.
   - **Severity mapping, per the spec:**
     - factcheck: `unsupported`, `contradiction` and `uncited_fact` are blockers; `overstated` is a warning;
     - reader: `missing_step` and `unanswered_question` are blockers only when they match a planned outline purpose or FAQ question (a loose word-overlap check is enough); everything else is a warning.
   - **Gate results:** write `article_gate_results` rows for the gates `factcheck` and `reader`, the same way the gates stage does.
   - **Output:** the same shape as `GatesOutput` (blockers carry `gate`, `message`, `excerpt` and `fix`), plus `dropped`.
   - **Transition:**
     - no blockers → `deliver`;
     - blockers, with revise loops left and not stalled (compared with the previous review output's `blockerCount`) → `revise`;
     - otherwise → `deliver`, with `escalated: true` and a reason.
6. **Wiring:**
   - The gates stage advances to `review` instead of `deliver` when it has no blockers and the mode's `review` list is non-empty.
   - The revise stage reads its blockers from the latest of the `gates` and `review` outputs (`findStageOutput(run, "gates", "review")`). It feeds `factcheck` and `reader` blockers into the prompt like the others.
   - After a revise, the flow is always `gates`, then `review`.
   - Add "Fact-check" and "Reader review" to the run view labels, and add a stage label for `review` wherever stage labels are listed (server `run-view.ts` and web).
7. **Eval harness:** `generateEngineArticle` in `evals/run.ts` runs the same loop with the review stage, so the evals measure the quality loop.
8. **Tests:**
   - excerpt filtering, severity mapping, the transitions (no blockers, revise, stall, escalation) and the mode gating;
   - gates → review → deliver, and review → revise → gates → review, using the fake LLM.
   - `bun test src/engine` and the server self-tests stay green.

## Task B: Revise with comments (editor)

1. **`POST /api/posts/:id/revise-with-comments`**, with the body `{comments: string (10–4000 chars), expectedUpdatedAt}`. It sits in `routes/posts.ts` or a small new route file, following how post updates check ownership and optimistic locking (look at the post `PUT` and `update_draft`, and reuse that service).
   - It returns 409 when the post changed, and checks `checkAccountGuardrails`.
   - It uses the OpenRouter key through `createEngineLlm` / `engineAiEndpoint` and the site's engine settings `revise` model (`resolveRunSettings("normal", parseEngineSettings(...))`).
   - It makes one call with a new prompt, `prompts/revise-comments.md`. The inputs are the current body, title and description, the owner's comments (fenced as data), the site voice, and the run's evidence when the post has a `runId` (or whatever links a post to its article run; find it). The reply is `{title, description, markdown}`. Then `normalizeDraftMarkdown`.
   - It saves through the existing post update path, so a revision is created, with the same lock. Spend is logged to `generation_logs`, and a sanitized operation event `posts.revise_comments` is written, with no text.
   - It returns the updated post.
   - Self-test: tenant scope 404, the 409 on a stale version, and a revision saved, with a fake LLM injected through a deps parameter like other routes do.
2. **Web:** in the post editor (`/library/posts/:id/edit`), a **Revise with comments** button opens a dialog with a textarea and a **Revise** button.
   - While the call runs, show "Revising…" and disable the controls.
   - On success, reload the post into the editor and toast "Revised; the previous version is in revisions". On a 409, say the post changed and offer to reload.
   - Follow the editor's existing patterns and the design system. Add a vitest for the dialog.
3. Checks as in the rules.
