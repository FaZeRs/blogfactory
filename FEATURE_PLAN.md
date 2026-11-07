# BlogFactory release plan

This is the canonical forward plan for BlogFactory. It records intended work, not proof that a feature is shipped. Agents must verify checked items in the current code and must not present unchecked items as available.

## Product decision

BlogFactory launched open source and self-hosted first. BlogFactory Cloud is the managed service built on this core.

BlogFactory Cloud has been live since 2026-09-15 with public signup and Polar checkout. Its packaging:

| Plan | Price | Sites | Storage | Concurrent generations | Active RSS feeds | Drafts per UTC month |
|---|---|---|---|---|---|---|
| Cloud | $5 monthly or $49 yearly | 3 | 1 GB | 1 | 3 | 150 successful drafts |
| Advanced | $15 monthly or $149 yearly | 10 | 10 GB | 3 | 20 | unlimited manual, up to 600 automated |

Plans include no AI credits; generation uses the customer's own OpenRouter key. A $20 Managed AI Credits pack (14,000 credits, valid 365 days) is defined but not on sale until Managed AI is enabled.

Polar is the payment layer. The private Cloud PostgreSQL database is authoritative for entitlements, quotas, and spendable credits. Checkout, subscriptions, entitlement enforcement, and billing webhooks live in the private `BlogFactoryHQ/blogfactory-cloud` repository, not in this open-source core, and never gate self-hosted instances.

## Phase 0 — open-source release

### Implemented in the release candidate

- [x] Docker Compose topology for web, API, PostgreSQL, MinIO, migrations, and the bounded scheduler.
- [x] Self-hosted account creation is explicit and can be disabled after the administrator account is created.
- [x] Self-hosting runbook, environment template, health checks, and persistent volumes.
- [x] Repository and marketing copy distinguish self-hosting from the future managed Cloud service.
- [x] Runtime signup configuration, instance-local MCP URL resolution, PostgreSQL/MinIO readiness, and fail-closed self-host secrets.
- [x] Versioned Compose image contract, source-build fallback, multi-architecture GHCR workflow, and disposable smoke/restore workflows.
- [x] Railway service topology and config-as-code contracts; marketplace publication still requires a real-project acceptance run.
- [x] Dokploy five-service blueprint, generated-secret contract, upstream validators, and disposable real-instance acceptance workflow.

### Required before calling the release public

- [x] Add the owner-selected AGPL-3.0-only license.
- [x] Audit the current tree and Git history for secrets, private customer data, licensed assets, and internal-only documents.
- [x] Confirm every bundled screenshot and brand asset is cleared for public redistribution.
- [x] Run the Docker Compose stack on a machine with a working Docker daemon and complete the smoke test in `docs/self-hosting.md`.
- [x] Preserve the existing Git history, subject to the public-release audit below.
- [x] Run the Dokploy blueprint on a disposable GitHub Actions instance and pass the Docker-equivalent health, signup, storage, MCP, scheduler, and persistence acceptance ([RC acceptance](https://github.com/BlogFactoryHQ/blogfactory/actions/runs/32888770507)).
- [x] Make `BlogFactoryHQ/blogfactory` public and verify the anonymous clone path.
- [x] Create a tagged release and attach upgrade/migration notes ([v0.1.0](https://github.com/BlogFactoryHQ/blogfactory/releases/tag/v0.1.0)).
- [x] Deploy the private-site “Open source / Cloud coming soon” marketing copy after the source URL became public.

## Phase 1 — self-host distribution

- [x] Publish versioned public multi-architecture API and web container images after the first tagged release.
- [ ] Submit the accepted Dokploy blueprint to the public template catalog and add its deploy link only after upstream merge.
- [ ] Publish a Railway template only after a separate real-project acceptance run; Railway is not a Phase 0 gate.
- [ ] Add a Render Blueprint only after its full web/API/worker flow passes the same smoke test.
- [ ] Submit to self-hosted directories after the repository, license, documentation, and release history satisfy each directory's rules.
- [ ] Add upgrade, backup, restore, and rollback acceptance checks to each release.

Netlify is not a full BlogFactory deployment target because it does not provision the complete API, worker, PostgreSQL, and object-storage topology. Do not add a misleading one-click badge.

## Phase 2 — BlogFactory Cloud

- [x] Run private Cloud heavy jobs in a persistent worker using the existing PostgreSQL-backed claims, retries, stale recovery, terminal states, and heartbeat health.
- [x] Deploy the private Cloud stack to Hetzner Nuremberg with immutable GHCR image digests, local PostgreSQL 18, age-encrypted database backups in private EU R2 storage, Cloudflare routing, and a clean Vercel application rollback deployment.
- [x] Migrate the existing production database and objects, verify row/object counts, encrypted backup readback, the 22-tool MCP catalog, and tenant/site isolation.
- [x] Merge the validated worker-mode core changes into the public `main` branch.
- [x] Implement verified email, password recovery delivery, abuse controls, and production login acceptance (hosted auth is WorkOS AuthKit in the private Cloud repository; lifecycle email beyond authentication is still open there).
- [x] Add authoritative usage counters for sites, storage, scheduled work, and concurrent generation (private Cloud repository).
- [x] Decide managed Cloud packaging and add server-side entitlements. The web may display them but is not the authority (private Cloud repository).
- [x] Choose a billing provider and implement idempotent webhooks outside MCP authority (private Cloud repository).
- [ ] Add export, cancellation, retention, backup/restore, spend caps, and support policies (cancellation, backup/restore, and credit spend caps exist privately; export, retention, and support policy remain open).
- [ ] Run a bounded private pilot and measure real infrastructure and support cost before public checkout.
- [ ] Run a real production purchase, refund, and chargeback-debt test with live webhook readback for every plan SKU.
- [x] Complete human legal review of the terms and privacy policy (signed off by counsel, 2026-09-21).
- [ ] Obtain written Polar acceptance for the AI-content use case and written OpenRouter confirmation before selling Managed AI Credits.
- [x] Publish marketing pricing, terms, and privacy pages that match the live packaging above (Managed AI Credits intentionally not offered until the Polar and OpenRouter confirmations above).

## Blog engine

Staged generation engine behind the `normal` and `deep` modes; design in `docs/superpowers/specs/2026-11-03-blog-engine-design.md`. Fast mode is unchanged. Self-hosted and Cloud both need the persistent worker for these modes.

- [x] Sub-project 1: staged runtime (research, brief, draft, gates, revise, deliver), search/crawl/DataForSEO adapters, eval harness (`npm run eval:engine`), `mode` on `generate_draft`, optional `publish_at` on `push_to_cms_draft`.
- [x] Make `normal` the default manual mode (2026-11-07 eval on 6 golden briefs: normal beat fast 6-0, mean 8.07 vs 5.83; Create Content falls back to fast when the engine is unavailable; MCP `generate_draft` keeps `fast` as its default).
- [x] Sub-project 2: research depth: competitor outlines, gaps and People also ask in the brief; more sources per run (normal reads 8 pages from 4 queries, spread round-robin across queries with at most 2 pages per site); DataForSEO keyword data in normal and deep briefs (volume, difficulty, intent, and related searches the brief picks secondary keywords from).
- [x] Sub-project 3: quality loop (adversarial fact-check, reader review, style gate, leak check, Revise with comments).
- [x] Sub-project 4: topic discovery (scored ideas, word-overlap novelty, schedule and autopilot, owner idea sources: feeds, Hacker News, subreddits, watched pages; built-in sources can be switched off).
- [x] Sub-project 5: localization (per-site locales, glossary, style guide, native review, parity checks, Lindevo `lv` delivery).
- [x] Sub-project 6: learning (owner-approved style rules from edits and comments, advisory eval check, refresh queue from Search Console).
- [x] Sub-project 7: covers and cover tools, the Lindevo provenance box, and the share kit (a LinkedIn post, a short thread, a newsletter blurb, pull quotes checked word for word against the article, and a teaser, written on request from the saved post and copied by hand).
- [x] Sub-project 8: AI answer visibility (weekly answer-engine probe).
- [ ] Cutover from the Lindevo engine (needs sub-projects 1, 3, 5 and 8, the pairwise eval win, and 6 approved real posts). Deferred by the owner (2026-11-07).

## Release language

Historical pre-release language, before Phase 0 was completed:

- Say: “Open-source release candidate. BlogFactory Cloud is coming soon.”
- Do not say: “Open source available now,” “one-click deploy,” or “hosted for $5” on a live public surface.

Current release language:

- Say: “Self-host BlogFactory for free.” Describe BlogFactory Cloud only as far as the published marketing, pricing, and legal pages already go.
- Link the primary CTA to the public source repository.
- Do not state Cloud prices, limits, or launch status in this repository; the private Cloud and marketing repositories own that copy.
