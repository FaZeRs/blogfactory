# Cover tools in the post editor: design spec

Date: 2026-11-04. Status: approved in conversation.

## Goal

Let a reviewer get a good cover without leaving the editor. They can:

- regenerate the cover;
- choose a style;
- see and edit the exact prompt;
- generate 1 or 3 options;
- adjust the current cover with a short instruction;
- switch between versions.

## Decisions

| Topic | Decision |
|---|---|
| Placement | A **Cover** section in the post editor, above the content editor. |
| Styles | Built-in presets, plus a site default chosen in Article Settings. The prompt box is filled from the article and the chosen style, and is editable. |
| Versions | Every generated, adjusted or uploaded cover is kept as a version, and versions show as thumbnails. A finished image becomes the cover (see "Version rule"). Clicking any version makes it the cover. Nothing is deleted. |
| Variants | **Generate 1** or **Generate 3**. The cost estimate is shown before the click. |
| Adjust | The current cover plus a short instruction go to the image model through OpenRouter's `input_references`. The result is a new version. |

## Presets

Each preset is a fixed style sentence. The site default can be any preset, or "Custom", which uses the existing `image_style_prompt` text.

- **Site default:** whatever Article Settings says.
- **Editorial photo:** realistic editorial photograph, natural light, shallow depth of field.
- **Flat illustration:** flat vector illustration, simple shapes, limited palette.
- **3D render:** soft 3D render, clean studio lighting, matte materials.
- **Abstract:** abstract composition of shapes and gradients that suggests the topic.
- **Brand colors:** uses the site's brand name and description from brand settings, and the style text if one is set.

Every preset keeps the existing rules: no text, logos, UI screenshots or watermarks unless the prompt asks for them.

The site default preset is stored in `user_settings.image_advanced_options.coverStylePreset` (existing JSON column, so no migration).

## Prompt

`buildImagePrompt` stays the single prompt builder. A new `coverPromptDraft(post, preset, settings)` returns the text the editor shows. The server accepts an edited prompt as is, but caps it at 2,000 characters and strips control characters. "Reset" rebuilds the draft.

## Data

Migration `0038_cover_versions.sql` (additive):

- `image_generation_requests.reference_path TEXT`: the stored image an Adjust request starts from.
- `image_generation_requests.replaces_cover TEXT`: the post's cover path when the request was queued (null if it had none).

Versions are the post's `image_assets` rows with `type = 'cover'`, newest first. They are labelled by `source_kind`:

- `ai` means "Generated";
- the new value `ai_edit` means "Adjusted";
- `manual` or `stock` means "Uploaded" or "Stock".

### Version rule

When a cover request finishes, it becomes the post's cover only if the cover has not changed since the request was queued (`posts.cover_image_url` still equals `replaces_cover`, with null equal to null). The image is kept as a version either way. Results:

- **Generate 1** replaces the cover.
- **Generate 3** applies the first to finish and keeps the others as versions.
- If the reviewer picks a version while generation is still running, their choice is never overwritten.

## API

All routes are tenant-scoped to the user and post. They return 404 for another user's post.

- `GET /api/images/posts/:postId/covers`. Returns:
  - the current cover;
  - each version (asset id, path, URL, source kind, prompt, model, created date);
  - pending requests (id, status, kind);
  - the prompt draft for the default preset;
  - presets;
  - the image model and whether it can edit;
  - the per-image cost estimate.
- `POST /api/images/posts/:postId/cover`. Body: `{ prompt?, preset?, count?: 1 | 3 }`.
  - Queues 1 or 3 forced requests and returns 202 with their request ids.
  - With no prompt, it builds the draft from the preset. With no preset, it uses the site default.
  - Without an image model it returns 400 with code `image_model_missing`, as today.
- `POST /api/images/posts/:postId/cover/adjust`. Body: `{ instruction }`, 3–500 characters.
  - Queues one request with `reference_path` set to the current cover. Returns 202.
  - Returns 400 when the post has no cover, or when the model cannot edit (code `image_edit_unsupported`).
- `PUT /api/images/posts/:postId/cover`. Body: `{ asset_id }`.
  - Makes one of the post's cover versions the cover, using the existing `attachPostImage` cover path.
  - Does not create a revision or change `updated_at`, the same as the destination route.

### Queue changes

- `force` makes a new request every time and never reuses a queued or finished one. The current code merges requests by type and position, which would collapse three requests into one.
- Image requests no longer require a job. `generateQueuedImageRequest` drops its `jobId` check, and image logs use the request id as the session when there is no job. This fixes covers for imported and hand-written posts.
- When `reference_path` is set, the image is sent as a base64 data URL in `input_references`, and the stored asset gets `source_kind = 'ai_edit'`.

### Edit capability

A model can edit when its OpenRouter image-model listing (`/api/v1/images/models`) shows it accepts input references. Look this up when the panel loads and cache it for the process lifetime, the same way `openrouter-models.ts` caches the model list.

## Web

`CoverPanel` replaces the current Generate cover button in the editor. It shows:

- the large current cover, or an empty state saying "No cover yet";
- a version strip of thumbnails with labels; click one to use it;
- a preset select, a prompt textarea with Reset, Generate 1 and Generate 3 buttons, and the cost for each;
- an Adjust input with a button, hidden when there is no cover or the model can't edit;
- pending requests as placeholder thumbnails.

While anything is pending, it refreshes `covers` every 3 seconds. It shows an error after 90 seconds, as the current button does.

The safety panel's cover check links to the Cover panel instead of having its own button. Article Settings gains a "Default cover style" select.

## Out of scope

- Text on covers.
- Styles for the images inside the article.
- Automatic covers for normal and deep runs.
- Deleting versions (the Image Gallery already does this).

## Testing

- **Server self-tests:**
  - the version rule (applies only when the cover is unchanged);
  - `force` creates separate requests;
  - adjust validation (no cover, no edit support, instruction length);
  - prompt cap;
  - tenant checks on all four routes.
- **Queue:** a fake OpenRouter call checks that an Adjust request sends `input_references`.
- **Web:** vitest for `CoverPanel`: versions render, picking a version calls PUT, Adjust is hidden without edit support.
- **Real run on the dev server:** Generate 1, Generate 3, Adjust, and switching versions on a real post.
