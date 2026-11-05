# Ideas, Lindevo components, deeper research and scheduling: design spec

Date: 2026-11-05.

The owner asked for this program: "generate ideas, which then could get converted into articles", Lindevo MDX components, scheduling, and deeper research. They also said to decide the open questions without asking. Each decision below says what was chosen and why.

## Goals

1. **Ideas.** BlogFactory finds topic ideas for a site, scores each one with an explained breakdown and writes a short brief for it. The owner approves, edits or rejects ideas; the owner's earlier choice was "confirm these ideas and create blog posts from them". An approved idea becomes a normal or deep article run.
2. **Scheduling.** Approved ideas get publish slots on a per-site calendar. Each article is generated ahead of its slot and its draft carries the slot as `publishAt`. Delivery stays draft-only: the owner still sends each draft to the CMS, and the Lindevo CMS publishes it at `publishAt`.
3. **Lindevo components.** When the destination is Lindevo, the engine writes with Lindevo's markdown components. It checks them with a port of Lindevo's own linter, so the CMS accepts every draft.
4. **Deeper research.** Research looks at what the top-ranking pages cover and what people ask. The plan then covers the gaps and adds information the current results lack ("information gain"), instead of repeating the consensus.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Topic gate | **The owner approves ideas.** An optional autopilot setting can approve the top N each week. Autopilot is off by default. | The owner asked to confirm ideas. Lindevo ran without a topic gate, so autopilot keeps that option open. |
| Clustering | **The model groups signals into ideas**, fed the signals with ids. No embeddings. | pgvector isn't installed in BlogFactory, and embeddings would need a second provider key. A model can group 50–150 short signals reliably. |
| Novelty | **Word-overlap similarity** (token Jaccard plus shared-bigram containment) of the idea's title and keyword against the site's existing posts and its sitemap or internal-link index titles. 0.85 or more: reject as duplicate. 0.6 or more: label "Refresh candidate" with the matching post. | No new dependency, and it is deterministic and testable. Lindevo's cosine thresholds of 0.85 and 0.75 are adapted to word overlap. |
| Scoring | **Weighted geometric mean, 0–100**, of trend, fit, demand, feasibility, novelty and information gain. Default weights are all 1. Fit, information gain and the model's demand come from a rating call; trend, novelty, search demand and feasibility are computed in code. | The same model as Lindevo, plus two factors 2026 practice treats as essential: whether the page can rank, and whether it adds new information. One factor at zero still sinks the score. |
| Weight learning | **Out of scope for now.** Weights are stored per site so learning can be added later. | It needs months of published outcomes. |
| Scheduling | **BlogFactory owns the calendar.** Each site has slots (weekdays and a time, plus timezone). Approving an idea books the next free slot unless the owner picks a date. A worker job starts the article run `leadDays` (default 3) before the slot. | The engine needs time to generate, and the owner needs time to review. |
| Publishing | **Draft-only.** A delivered draft stores `publishAt`. The Send to CMS dialog pre-fills it, and Lindevo receives it with the existing `publish_at`. Other CMSs get the date as a reminder only. | This product boundary doesn't change. |
| Components profile | **The profile is picked per run:** "lindevo" when the run's destination provider is Lindevo, otherwise "markdown". | The spec for the staged engine already said this. Other CMSs can't render these components. |
| Component set | Lindevo's engine set: `key-takeaways`, `workflow`/`workflow-step`, `callout`, `steps`/`step`, `service-cta`. `provenance` is added by code at delivery. | This matches what Lindevo's engine writes and what its CMS accepts. |
| Linter | **Vendor Lindevo's `packages/mdx` lint**, about 1,300 lines with no runtime dependencies, into `server/src/engine/components/`, with a header naming the source. | The CMS rejects anything that fails this linter, so BlogFactory must check exactly the same rules. |
| Competitor analysis | **Read the top 3–5 search results for the main keyword** (with the existing reader, which already reads the research pages), pull out their H2/H3 outline and word count, and ask the model for a gap analysis. Deep mode adds DataForSEO "People also ask"; normal mode uses SearXNG results. | Gap analysis is the standard input for a brief that adds information gain. It reuses the existing adapters. |
| MCP | **No new MCP tools.** | A new tool needs a separate product and security decision (AGENTS.md). Ideas are a web feature for now. |

## A. Lindevo components

- `server/src/engine/components/` holds the vendored code:
  - `component-spec.ts`, `lint.ts`, `lint/*`, `lib/*`, `faq.ts`, and the `OPEN_RE` and `CONTAINER_TAGS` constants;
  - Lindevo's lint tests, ported to `bun:test` as a parity check;
  - `guide.ts`, which builds the writer guide (the same shape as Lindevo's `componentGuide`) for the engine tag set.
- `profile.ts` exports `componentProfile(run)`, which returns `"lindevo" | "markdown"`. It reads the run's preferred integration provider, frozen into the run's settings at start as `destinationProvider`.
- **Prompts.** The brief, draft and revise prompts get a `{{components}}` block.
  - For the markdown profile it reads: "Plain Markdown only. No HTML or custom tags."
  - For the Lindevo profile it contains the guide plus Lindevo's placement rules:
    - `key-takeaways` right after the opening;
    - a `workflow` only for a 2–8 step process;
    - one `service-cta` before the FAQ, exactly as given;
    - no provenance and no H1.
- **The brief chooses a service and pain point for the Lindevo profile**, from the enums, or "none" when nothing fits honestly. The Lindevo service and pain-point lists are hard-coded in the vendored spec. The draft gets the exact `service-cta` tag; with "none", no CTA is written.
- **Gate `components`.** It runs only for the Lindevo profile and turns lint errors into blockers that name the rule and line. It also runs Lindevo's structure gate checks:
  - exactly one `key-takeaways`;
  - at most one `service-cta`, with the chosen service and anchor;
  - no `provenance`;
  - no H1.
- **The citation system still applies.** `{{c:id}}` markers become numbered references, and the "## Sources" section is kept; Lindevo's linter already strips a Sources section.
- **Deliver** appends `<provenance sources="N" checks="N" reviewed="YYYY-MM-DD" models="…">` for the Lindevo profile:
  - `sources` is the distinct cited verified sources;
  - `checks` is the gates passed;
  - `reviewed` is the delivery date. The owner reviews before sending, and Lindevo shows this as the date it was reviewed.
  - `models` is the draft and revise model display names.
- **Preview.** BlogFactory's own preview renders component tags as simple labelled blocks, so the owner can read the draft: takeaways as a box, a workflow as numbered cards, a callout as a note box, the CTA as a placeholder. Exact rendering is the CMS's job.

## B. Deeper research

The research stage gains a `competitors` step after search. It is enabled in normal and deep mode.

1. The SERP for the topic comes from DataForSEO in deep mode, or SearXNG otherwise. Read the top 3–5 organic results that are not the site itself, through the existing reader with the same security checks.
2. For each result, extract the H2/H3 headings, the word count and the title in code, from the markdown. Store them as `article_sources` rows of kind `competitor`; a new column `kind` (`evidence`/`competitor`) is added.
3. Collect the questions people ask: DataForSEO "People also ask" in deep mode, and in all modes the questions in the SERP titles and snippets.
4. One model call produces a `serpAnalysis` from the competitor outlines and questions:
   - `coveredTopics` (the consensus everyone has);
   - `gaps` (questions or angles no competitor answers well);
   - `informationGain` (2–4 concrete things this article can add, backed by the evidence);
   - `searchIntent`;
   - `typicalLength`.
   It is stored in the research output.
5. **Brief prompt.** The plan covers the covered topics briefly, devotes sections to the gaps and information-gain points, and uses the questions as FAQ candidates. A word-count target derived from `typicalLength` (clamped to the plan limits) replaces the fixed plan when it is available.
6. **Run view.** A "Competitors" block under Research lists each result with its outline, plus the gaps and the information-gain points.

## C. Ideas

### Data model (migration `0039_ideas.sql`)

**`ideas` table.** All columns:
- `id`, `user_id`, `site_id`
- `status` text, one of: `new`, `approved`, `scheduled`, `in_progress`, `drafted`, `rejected`, `archived`
- `title`, `angle`, `primary_keyword`, `alternate_keywords` (text[]), `search_intent`, `audience_question`
- `brief` (jsonb): `whyNow`, `outline` (string[] with 3–6 headings), `informationGain` (string[]), `sources` (`{url, title}[]`), `suggestedMode` (`normal`|`deep`)
- `score` (real), `score_breakdown` (jsonb):
  - factors 0–1: `trend`, `fit`, `demand`, `feasibility`, `novelty`, `gain`
  - plus `keyword` (`{volume, difficulty, intent}` or null), `nearestPost` (`{id, title, similarity}` or null), and `rationale`
- `origin`: `discovered`, `manual` or `refresh`
- `discovery_id`, `mode` (normal/deep, the default from settings), `scheduled_for` (timestamptz)
- `job_id`, `post_id`, `rejected_reason`, `created_at`, `updated_at`

**`idea_discoveries` table.** Columns:
- `id`, `user_id`, `site_id`
- `status`: `queued`, `running`, `done` or `failed`
- `signal_count`, `idea_count`, `cost_usd`, `error`
- `started_at`, `finished_at`, `created_at`

Discoveries run on the existing worker. Each is claimed with `FOR UPDATE SKIP LOCKED`, like article runs.

**Site idea settings.** These go in the existing settings JSON, under `idea_settings`:
- `cadence`: `{ weekdays: number[], time: "HH:MM", timezone }`, default Monday and Thursday at 08:00 in the site's timezone, or UTC
- `leadDays`, default 3
- `defaultMode`, default `normal`
- `autopilot`: `{ enabled: false, approvePerWeek: 2, minScore: 60 }`
- `weights`
- `seedTopics` (string[]): the site's `topics`/`editorialTopics` plus any extras
- `competitors` (domains), optional

### Discovery pipeline (`server/src/services/ideas/`)

1. **Collect signals.** Each collector has a time limit, and a failure is recorded without stopping the others. A signal is `{ id, source, title, summary, url, metric? }`.
   - **Search Console:** queries with many impressions where the site ranks poorly (position 8–30) or has no page targeting the query. Uses the stored `searchConsoleMetrics` for the site.
   - **SearXNG news:** searches for each seed topic in the news category over the last 30 days.
   - **DataForSEO** (when configured): `keyword_ideas` or related keywords for 3–5 seed topics, kept when volume is above 0. This adds volume, keyword difficulty and intent.
   - **People also ask** for seed topics (DataForSEO in deep mode, or SearXNG related-question suggestions).
   - **The site's RSS feeds:** recent item titles from feeds already configured for the site.
   - **Competitor sitemaps:** pages added in the last 30 days, when competitors are configured.
   Signals are deduped by normalized URL and title and capped at 150 per discovery.
2. **Generate candidates (model).** The model gets the signals, the site context (name, topics, brand description, audience) and the titles of existing posts. It proposes up to 20 ideas, each with:
   - `title`, `angle`, `primaryKeyword`, `alternateKeywords`, `searchIntent`, `audienceQuestion`, `whyNow`, `outline`, `signalIds` (used for trend and sources);
   - `fit`, `gain` and `demandEstimate` ratings (0–10), and a `rationale`.
   The prompt follows the staged engine's untrusted-data fencing.
3. **Enrich in code.**
   - **Keyword metrics:** DataForSEO keyword overview for each primary keyword, batched and cached in memory for the process.
   - **Novelty** against existing posts, using word overlap.
   - **Trend** from the signals: count, distinct sources and recency, as in Lindevo's formula.
   - **Feasibility** from keyword difficulty: 1 − KD/100, floored at 0.15. With no data it uses 0.6.
   - **Demand:** `0.6·clamp(log10(1+volume)/4) + 0.4·demandEstimate/10`, falling back to the model estimate when there is no data. Volume 0 caps demand at 0.2 unless trend is at least 0.6.
4. **Score:** the weighted geometric mean, 0–100. Duplicates (novelty below 0.15) are dropped. Refresh candidates are kept with `origin: refresh` and the matching post shown.
5. **Persist:** discovered ideas with status `new`. An idea whose title is too close to an existing idea that is not rejected is skipped. The number of ideas, the cost and the signal sources are logged in the operation ledger, without any text.
6. **Autopilot,** when enabled: approve the top `approvePerWeek` ideas at or above `minScore`, then book slots for them.

A discovery costs about $0.05–0.20, for one candidate call and the DataForSEO lookups.

### Lifecycle and scheduling

- **Approve** (`new` → `scheduled`): optionally edit the title, angle, keyword or mode first. It books the next free cadence slot after today plus `leadDays`, or uses a date the owner picks. A slot can hold one idea.
- **Start the run.** The worker job `ideas-due` runs every cycle with a cheap query. For each scheduled idea whose `scheduled_for − leadDays` has passed, it starts an article run:
  - `topic` = the title;
  - `sourceType` = `article_title`;
  - guidance = the angle, why-now and outline as instructions;
  - the primary keyword is passed to the brief;
  - the site's default destination;
  - a cover if the site has an image model.
  The idea moves to `in_progress` with its `job_id`.
- **"Write now"** starts the run immediately. The slot stays if one was set.
- **Delivery** links the post (`ideas.post_id`, status `drafted`) and stores `posts.publish_at` (new column, timestamptz, null when unset) from the idea's slot.
- **A failed run** returns the idea to `scheduled`, with the error, so it can be retried.
- **Reject** asks for an optional reason. **Archive** hides the idea. **Reschedule** moves it to another free slot or date.
- **Send to CMS:** the dialog pre-fills `publish_at` from `posts.publish_at`.

### API (`/api/ideas`, all scoped to the user and site)

- `GET /api/ideas?siteId&status&sort` lists ideas.
- `POST /api/ideas/discover {siteId}` queues a discovery; at most one runs per site.
- `GET /api/ideas/discoveries?siteId` returns the latest discoveries.
- `POST /api/ideas {siteId, title, angle?, primaryKeyword?}` adds a manual idea and scores it with a one-idea enrich and rating call.
- `PATCH /api/ideas/:id` edits the title, angle, primary keyword, alternate keywords, mode or outline.
- `POST /api/ideas/:id/approve {scheduledFor?}`
- `POST /api/ideas/:id/reject {reason?}`
- `POST /api/ideas/:id/write-now`
- `POST /api/ideas/:id/reschedule {scheduledFor}`
- `GET /api/ideas/calendar?siteId&from&to` returns the slots with the idea or post in each.
- `GET` and `PUT /api/settings/ideas?siteId` read and write the idea settings.

### Web

- **Sidebar:** a new **Ideas** item at `/ideas` under Operate, between Create Content and Review Queue. Its tabs:
  - **Inbox:** new ideas, sorted by score. Each card shows the title, score with breakdown bars and explanations, keyword data, a "Refresh of: …" badge, the angle, why now, outline, information-gain points and sources. Actions: Approve, with a date picker defaulting to the next slot; Edit; Write now; Reject.
  - **Planned:** approved, scheduled and in-progress ideas, with their slot and run status (linked to Runs).
  - **Calendar:** a month grid of the cadence slots. Each slot shows its idea or draft and its status. A draft opens the editor. Rescheduling works by choosing a new date.
  - **Settings:** cadence, lead days, default mode, autopilot, seed topics and competitors.
- A **Discover ideas** button with discovery status, plus "last run" and its cost.
- **Create Content** gets a link: "Have no topic? Discover ideas."

## Testing

- **Lint:** the vendored lint passes its ported parity tests.
- **Profile:** profile selection and the components gate.
- **Provenance:** builder plus deliver for the Lindevo profile.
- **Competitors:** outline extraction (headings and word count), the `serpAnalysis` schema, and the brief prompt including the gaps.
- **Ideas:**
  - signal collectors (fakes);
  - novelty similarity;
  - the scoring formula, including the zero factor and the demand cap;
  - slot booking, with no double booking and respecting the cadence and timezone;
  - the due-start query;
  - the full lifecycle (approve → start → deliver → drafted → `publish_at` set) against the test DB;
  - tenant checks on every route.
- **Web:** Ideas page cards and actions, calendar render, and settings.
- **Real run on the dev server:** a discovery for the Lindevo site, approve one idea, write it now in normal mode to the Lindevo destination, check that the components lint is clean and provenance is present, and check that `publish_at` is pre-filled in Send to CMS.

## Out of scope

- Weight learning.
- Embeddings.
- AI-answer visibility probes (sub-project 8).
- Localization.
- MCP tools for ideas.
- Automatic CMS sending.
- Refresh runs that rewrite an existing post in place (a refresh idea creates a new draft linked to the old post).

## Addendum (2026-11-05): idea MCP tools and weight learning

The owner approved both after the first version shipped. Their request is the product decision, and the security boundary stays as AGENTS.md sets it.

### MCP tools for ideas

The catalog grows from 22 to 26 tools. Every new tool is site-scoped, uses the services the web routes already call, writes a sanitized operation event, and introduces no new scope:

| Tool | Scope | What it does |
|---|---|---|
| `list_ideas` | `content:read` | Lists ideas for a site: status filter, sort by score, newest or scheduled, limit up to 50. Returns the fields the Ideas inbox shows (score breakdown, keyword data, brief, slot). |
| `discover_ideas` | `drafts:write` | Queues a discovery, the same as the Discover button. It returns the discovery, and agents can poll it with `list_ideas`. |
| `approve_idea` | `drafts:write` | Approves an idea and books a slot (optional `scheduled_for` and edits). It never starts a run outside the schedule. Agents use `generate_draft` to write immediately. |
| `reject_idea` | `drafts:write` | Rejects an idea, with an optional reason. |

The boundary still holds: nothing is published, deleted or bulk-changed, and no credential is exposed. A scheduled idea becomes a CMS draft only through the existing draft-only path, and sending to the CMS still needs `push_to_cms_draft` with its preflight checks. The docs and catalog assertions change from 22 to 26.

### Learning score weights

These rules follow Lindevo's `learning/weights.ts`, adapted to BlogFactory.
- **Sample:** an idea whose post has `postPublications` status published (or a live publication) and whose slot or publication date is at least 30 days old.
- **Outcome:** `ln(1 + clicks)` over the 28 days after the post's first 30 days. It comes from `search_console_metrics` rows for the site whose `page_url` path ends with `/<seo slug>` (normalized: lower case, no trailing slash).
- **Update:** for each factor, `corr` is the Pearson correlation between the factor values and the outcomes across samples. The new weight is `clamp(w·(1+0.1·clamp(corr,−1,1)), 0.1, 3)`, rounded to 4 decimals.
- **Guards:** at least 5 samples, and a factor with no variance keeps its weight. The weights move at most once per calendar month per site, recorded as `weightsLearnedMonth`.
- **Storage:** in `idea_settings`, as `weights`, `weightsLearnedMonth` and `weightHistory` (the last 24 entries: `{month, weights, samples}`). A setting `learnWeights` (default true) lets the owner freeze the weights.
- **Schedule:** the worker's daily periodic task runs it for every site with ideas.
- **Settings page:** shows the current weights, whether learning is on, the last month learned, the sample count, and the history.
