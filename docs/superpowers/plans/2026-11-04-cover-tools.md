# Cover tools: implementation plan

**Spec:** `docs/superpowers/specs/2026-11-04-cover-tools-design.md`. Read it first; it is the source of truth.

**Branch:** `docs/blog-engine-spec`.

**Repository rules:**
- Every query is scoped to the user (and to the post where relevant).
- Migrations are additive raw SQL in `server/src/db/migrations/`, and are mirrored in `server/src/db/schema.ts`.
- Server tests are `*.self-test.ts`, run with `bun <file>`, or `bun:test` files under `src/engine`.
- Database tests may write only to `blogfactory_engine_test`. To get its URL, take the `DATABASE_URL` in `server/.env` and replace the trailing `/blogfactory` with `/blogfactory_engine_test`. Also set `POSTGRES_INTEGRATION_ALLOW_WRITES=1`. Never write tests against `blogfactory`.
- Web: React 18, React Query, shadcn-style UI under `web/src/components/ui`, and vitest tests using the `createRoot` + `act` pattern (see `web/src/components/runs/EngineRunView.test.tsx`). Testing Library is not installed.
- Match the surrounding code style. Keep diffs small. Don't push. Commit once at the end of each task, ending the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Verified facts:**
- OpenRouter `POST /api/v1/images` accepts `input_references: [{ type: "image_url", image_url: { url: "data:image/webp;base64,..." } }]`. A real edit with `google/gemini-3.1-flash-image` took 12 seconds and cost $0.068.
- `GET /api/v1/images/models` returns `data[]`. A model can edit when `supported_parameters.input_references` exists and its `max` is at least 1.

## Task 1: queue and storage (server)

Files:
- `server/src/services/ai-image-queue.ts`
- `server/src/services/generate-content.ts`: `generateQueuedImageRequest`, `generateSingleImage` and `openRouterImageRequestPayload`
- `server/src/services/low-cost-images.ts`
- `server/src/db/schema.ts`
- a new migration `0038_cover_versions.sql`

Changes:
1. **Migration.** Add `image_generation_requests.reference_path TEXT` and `replaces_cover TEXT`, both nullable, and mirror them in `schema.ts`. Add both to the raw `RETURNING` list in the claim SQL in `ai-image-queue.ts`, as `"referencePath"` and `"replacesCover"`.
2. **`queueDeferredImageRequest`.** Accept `referencePath?: string | null` and `replacesCover?: string | null`.
   - With `force`, always insert a new request. Skip reusing queued and finished requests entirely; today it updates an existing queued one.
   - Store the two new fields.
   - `resolvePostImages` passes `force` through already. It should also accept and pass `replacesCover`.
3. **Requests without a job.**
   - Remove the `!request.jobId` requirement in `processClaimedDeferredImage` and the throw in `generateQueuedImageRequest`.
   - Let `generateSingleImage` take `jobId: string | null`. Log `sessionId: jobId ?? request id`; add a parameter if needed.
   - `saveImageBuffer` must accept a null `jobId`.
4. **Adjust.**
   - When `request.referencePath` is set, load the image with `getObject` from `./s3-client.js` and send it as a base64 data URL in `input_references`. Extend `openRouterImageRequestPayload` with an optional `references` argument, and add a unit assertion for the payload shape.
   - Store the asset with `sourceKind: "ai_edit"`; otherwise it stays `"ai"`.
5. **Version rule.**
   - For `type === "cover"` requests, call `attachPostImage` only when the post's `cover_image_url` still equals `request.replacesCover` (null equals null). Otherwise keep the asset with `postId` set and status `"used"` so it appears as a version, and mark the request done.
   - Put the decision in a small pure function, `shouldApplyCover(currentCover, replacesCover)`, and test it.
   - This rule applies only when a request has the new fields; non-cover and old requests behave exactly as today. Use a dedicated marker, e.g. `provider: "ai-cover"`, or the presence of the new columns, so batch-generation covers keep today's behaviour.

Tests:
- A self-test for `shouldApplyCover`.
- A self-test for the payload, with and without references.
- A database self-test against the test DB:
  - `force` queueing three times creates three rows;
  - a request with no job is accepted by `processClaimedDeferredImage` when the generator is faked. Inject the generator through a parameter, or test only the pure parts if injection is too invasive.
- Run `bun test src/engine` and `npm run test:server`. Two self-tests failed before this work (`routes/auth.self-test.ts` and `services/search-console.self-test.ts`); no other failure is acceptable.

## Task 2: routes, presets and settings (server)

Files:
- `server/src/routes/images.ts` (an editor cover route exists at `POST /posts/:postId/cover`)
- a new `server/src/services/cover-tools.ts`
- `server/src/services/image-slots.ts`
- `server/src/routes/settings.ts`
- `server/src/services/openrouter-models.ts`

Changes:
1. **`cover-tools.ts`.**
   - `COVER_PRESETS`: ids `site_default`, `editorial_photo`, `flat_illustration`, `3d_render`, `abstract` and `brand_colors`, each with a label and a style sentence taken from the spec. `brand_colors` builds its style from `settings.brandCompanyName`, `settings.brandDescription` and `imageStylePrompt`.
   - `coverPromptDraft({ title, content, preset, settings })`: reuses `buildImagePrompt` with the preset's style.
   - `cleanCoverPrompt(text)`: strips control characters except newlines, trims, caps at 2,000 characters, and requires at least 10 characters.
2. **Edit capability.** Add `imageModelCanEdit(apiKey, modelId)`, which reads `https://openrouter.ai/api/v1/images/models` and caches it in memory per process with a TTL, matching how the file already caches the model list. It returns false on fetch errors.
3. **Routes.** All of them read the post with `and(eq(posts.id), eq(posts.userId))` and return 404 otherwise.
   - `GET /posts/:postId/covers` returns:
     - `cover` (path and public URL);
     - `versions`: `image_assets` rows with `type='cover'` for this user and post, newest first, as `{ id, path, url, source_kind, prompt, model_id, created_at }`;
     - `pending`: queued or processing cover requests for this post, `{ id, status, kind: reference_path ? "adjust" : "generate" }`;
     - `presets`, `default_preset`, `prompt_draft` (for the default preset), `image_model`, `can_edit`, and `cost_per_image`.
     - Find the public URL helper (`getPublicUrl` in `s3-client.ts`) and match how other routes return image URLs; check `routes/images.ts` gallery responses.
   - `POST /posts/:postId/cover`, body `{ prompt?, preset?, count? }`:
     - `count` must be 1 or 3 (default 1);
     - a supplied `prompt` goes through `cleanCoverPrompt` (400 if invalid); otherwise use `coverPromptDraft`;
     - queues `count` forced requests with `replacesCover` set to the current cover;
     - returns 202 `{ request_ids }`;
     - keeps the existing 400 with code `image_model_missing`.
   - `POST /posts/:postId/cover/adjust`, body `{ instruction }`, which must be 3–500 characters after trimming:
     - 400 with code `cover_missing` when there is no cover;
     - 400 with code `image_edit_unsupported` when `imageModelCanEdit` is false;
     - otherwise queues one forced request with `referencePath` set to the current cover, `replacesCover` set to the current cover, and the prompt `Edit this image: <instruction>. Keep the composition and subject unless the instruction says otherwise. No text, logos or watermarks.`;
     - returns 202.
   - `PUT /posts/:postId/cover`, body `{ asset_id }`:
     - the asset must belong to this user and post and have `type='cover'`, otherwise 404;
     - sets it as the cover through `attachPostImage(postId, slot, asset.storagePath, "auto", userId)`;
     - does not create a revision;
     - returns `{ cover_image_url }`.
   - Kick the image worker after queueing, as the current route does.
4. **Settings.** Have `GET` and `PUT /api/settings` read and write `image_advanced_options.coverStylePreset`, validated against the preset ids. Follow how the same JSON column's existing fields are handled (`coverResolution`).

Tests:
- A self-test for presets, `cleanCoverPrompt` and `coverPromptDraft`.
- A database self-test against the test DB covering:
  - 404 on another user's post for each route;
  - count validation;
  - adjust with no cover;
  - `PUT` with another post's asset.
- Then `npm run typecheck` and `npm run test:server`.

## Task 3: the Cover panel (web)

Files:
- a new `web/src/components/posts/CoverPanel.tsx` and its test
- `web/src/pages/PostEditorPage.tsx`
- `web/src/components/posts/EditorialSafetyPanel.tsx`: remove `GenerateCoverButton`, and make the cover check link to `#cover`
- `web/src/pages/Settings.tsx`: add a "Default cover style" select near the image style prompt

`CoverPanel` follows the spec's Web section and uses `BywordCard` and `SectionHeader`. It shows:
- the large current cover, or an empty state;
- a version strip of clickable thumbnails with a label for each kind: "Generated", "Adjusted", "Uploaded" or "Stock". The current one is highlighted, and clicking another calls `PUT`;
- a preset `Select`; changing it resets the prompt from the matching draft. Fetch the draft with `GET ?preset=`, or build drafts on the server for every preset and return them. Pick one approach and document it in the commit;
- a prompt `Textarea` with Reset;
- **Generate 1** and **Generate 3** buttons, labelled with costs, e.g. `$0.04` and `$0.12`;
- an Adjust input and button, shown only when there is a cover and `can_edit` is true;
- pending items as spinner thumbnails.

While anything is pending it polls every 3 seconds, and invalidates the `["post", id]` and `["post-preflight", id]` queries when a cover changes. After 90 seconds with requests still pending, it shows the same toast as today. The panel goes in the editor below the title card, with `id="cover"`. If `image_model_missing` comes back, it shows a link to `/control/article-settings`.

Test (vitest) that:
- versions render with labels;
- clicking a version sends `PUT` with its `asset_id`;
- Adjust is hidden when `can_edit` is false;
- Generate 3 posts `count: 3`.

Mock `api` the same way existing tests mock it; search for `vi.mock("@/lib/api"`.

Then run:
- `npm run typecheck`;
- eslint on the changed files;
- `npm run test --workspace=web`. Nine test files failed before this work; no new failure is acceptable.
- `npm run build`.

## After the tasks

The controller tests on the dev server: Generate 1, Generate 3, Adjust and switching versions on a real post.
