# Quality loop (sub-project 3): design spec

Date: 2026-11-06. This is sub-project 3 of `2026-11-03-blog-engine-design.md`. The owner approved starting it, and asked that testing use cheap or free OpenRouter models. Open questions are decided here, each with its reason.

## Goal

Before an article reaches review, catch what the code gates can't see:
- claims the sources don't support;
- facts with no citation;
- passages the target reader would find confusing or thin;
- phrasing that reads as machine-written.

After review, let the owner revise a draft from their own comments.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Where it runs | A new engine stage, **`review`**, after `gates`. Gates still run first and cost nothing. Only a draft with no code blockers reaches `review`, so paid checks never read a draft that is already known to be broken. | It fits the staged runtime; the Runs view shows the stage, its cost and its findings. |
| Checks | **Fact-check** and **reader review**, one model call each, with typed JSON output. | They are the two failure classes code can't detect. |
| Fact-check | It is adversarial: the prompt tells the model to look for problems, not to approve. It receives the draft with its `{{c:id}}` markers and the verified evidence (claim and quote). It returns issues of these kinds: `unsupported` (the cited quote doesn't say it), `overstated` (stronger than the quote), `uncited_fact` (a specific number, date, name or statistic with no citation) and `contradiction`. Each issue gives an `excerpt` copied from the draft and a `fix`. | It checks against the frozen evidence, not the open web, so it is repeatable and cheap. |
| Reader review | The model reads as the brief's audience (the site topic plus the brief's angle and primary keyword). It returns up to 6 issues: `unclear`, `missing_step`, `unanswered_question` (from the brief's FAQ or angle), `padding` or `jargon`. Each has an `excerpt` and a `fix`. | It covers usefulness, which the gates can't measure. |
| Hallucinated findings | An issue whose `excerpt` isn't found in the draft (after whitespace and quote normalization) is dropped. | A cheap model must not invent problems that cause needless rewrites. |
| Severity | Fact-check issues `unsupported`, `contradiction` and `uncited_fact` are blockers; `overstated` is a warning. Reader issues are warnings, except `missing_step` and `unanswered_question` when the brief planned them, which are blockers. | Wrong facts are never acceptable; style is advisory. |
| Loop | `review` blockers go to `revise` (the same stage and prompt, with gate names `factcheck` and `reader`). Then `gates`, then `review` again. The run shares `maxRevise` with the code gates and has the same stall rule: stop when the blocker count doesn't shrink. Blockers that remain escalate, as gates do now. | One loop and one budget; no new failure paths. |
| Modes | Deep runs fact-check and reader review. Normal runs fact-check only. Fast is unchanged. | Wrong facts are the biggest risk at any price; reader review costs a second read. |
| Model | A new role, **`review`**. It defaults to the mode's writer model and can be overridden in the site's engine settings like every other role. | The owner tests on cheap and free models; one place to set them. |
| AI-tell cleanup | A code gate, **`style`**, with a maintained list of machine-sounding phrases ("delve", "in today's fast-paced world", "it's important to note", "unlock the power of", "navigate the complexities", "tapestry", "game-changer", and others) and a limit on em dashes per 1,000 words. 3 or more hits, or more than 6 em dashes per 1,000 words, is a blocker that names each excerpt. | It is deterministic and free. Revise removes the phrases; no model sanitizer is needed. |
| Revise from comments | A **Revise with comments** action in the post editor. The owner writes free-text comments and can quote passages. One revise-prompt call rewrites the body with the post's evidence (when the post came from a run) and the site voice. It saves as a new revision, with optimistic locking (`expectedUpdatedAt`) and a 409 on conflict. Spend is logged and account guardrails apply. No MCP tool is added: agents already edit with `update_draft`. | Owner control with no new agent authority. |
| Evals | `npm run eval:engine -- --mode normal@<model>` runs every role on one model, so cheap and free models can be compared against the baseline on the golden briefs. The eval waits out rate limits (free models hit them often). | The owner asked for cheap testing; the harness already judges pairwise. |

## Data

No new tables:
- `article_stage_runs` stores the `review` output: blockers, warnings and the counts per check.
- `article_gate_results` gets rows for `factcheck`, `reader` and `style`, so the review packet and Runs show them like any other gate.

The editor's revision uses the existing post revisions.

## Out of scope

- Live web fact-checking.
- A second-opinion model family.
- Persona libraries.
- Localization (sub-project 5).

## Testing

- **`review` stage:** unit tests with a fake LLM covering excerpt filtering, severity mapping, the transition to `revise` or `deliver`, the stall rule and the mode gating.
- **`style` gate:** tests for the phrase list and the em-dash ratio.
- **Revise with comments:** a route self-test for tenant scope, the 409 on a stale version, the revision being saved and the spend being logged.
- **Eval:** a real run comparing a cheap model against a free model on 3 golden briefs, then the same comparison with the quality loop on, to check that it helps.
- **Real run on the dev server:** generate one lindevo.com article in normal mode with cheap models and inspect the review findings in Runs.
