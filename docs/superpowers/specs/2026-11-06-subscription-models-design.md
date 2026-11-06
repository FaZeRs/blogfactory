# Subscription models (Claude Code, Codex): design spec

Date: 2026-11-06. The owner asked to use their Claude and ChatGPT subscriptions, as Lindevo's content engine does (`packages/engine-kit/src/llm/claude-cli.ts` and LiteLLM's `chatgpt/` route), instead of paying per token through OpenRouter.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Transport | Claude: the headless Claude Code CLI (`claude -p`). Codex: the Codex CLI (`codex exec`). Both run on the API/worker host that already runs the engine. | A subscription is reachable only through its own client. The CLIs support JSON-schema output (`--json-schema`, `--output-schema`), which the engine needs. Lindevo uses the same Claude path. |
| Isolation | **Claude:** `--tools ""`, `--disallowedTools "mcp__*"`, `--strict-mcp-config`, `--safe-mode`, `--setting-sources project`, hooks disabled, `--no-session-persistence`, `--permission-mode dontAsk`, a fixed empty working directory, and a clean environment (PATH, HOME, an optional `CLAUDE_CODE_OAUTH_TOKEN`).<br>**Codex:** a dedicated `CODEX_HOME` that holds only the login; `--ignore-user-config` and `--ignore-rules`; a read-only sandbox; the shell tool, apps, plugins, browser and computer use, and web search all off; `--ephemeral`. | Prompts carry untrusted web text. A probe showed that Codex runs shell commands and reads the user's instruction files unless they are switched off. With these flags it refused. |
| Who may use it | Off unless the instance sets `ENGINE_SUBSCRIPTIONS` (`claude-code`, `codex`, or both) **and** lists the allowed account emails in `ENGINE_SUBSCRIPTION_USERS`. Anyone else asking for a subscription model gets an error, or their fallback model. | A subscription belongs to one person. A multi-user instance, including Cloud, must not spend the owner's subscription on other accounts. |
| Checks | Saving engine settings and starting a run both reject a subscription model the account isn't allowed to use. Emails are stored lowercased, with a unique index on `lower(email)` (migration 0044), so a differently-cased signup can't match the allow-list. Calls made inside a web request (revise with comments, question suggestions) stop after 3 minutes or when the client disconnects. | Fail early and safely. |
| Choosing it | A role's model id in the site's engine settings: `claude-code:<model>` or `codex:<model>`. It may name an OpenRouter fallback after `\|`, for example `claude-code:claude-opus-5-5\|anthropic/claude-opus-5.5`. | It reuses the per-role model settings and needs no new UI. |
| Fallback | Any subscription failure (usage limit, CLI missing, not logged in, timeout, bad output) uses the fallback model when one is named. Without a fallback, a usage limit waits like a provider 429 (the run reschedules after 30 minutes without spending an attempt); other errors go to the stage's normal retry. | This matches Lindevo's subscription-then-API routing. |
| Cost | Subscription calls are logged at $0, so the run budget and the account guardrails count only paid calls. | No per-token charge. |
| Scope | Every engine call path: the article engine, idea discovery, AI-visibility question suggestions, and revise-with-comments. OpenRouter is still needed for anything set to an OpenRouter model, and for image generation and the AI-answer checks. | The model calls share one LLM client. The answer checks need web search, which these CLIs aren't used for here. |

## Configuration (self-hosted / owner instance)

```bash
ENGINE_SUBSCRIPTIONS=claude-code,codex
ENGINE_SUBSCRIPTION_USERS=info@lindevo.com
# Claude: log the CLI in on the host (claude auth login), or set a long-lived token from `claude setup-token`
CLAUDE_CODE_OAUTH_TOKEN=...            # optional
# Codex: a login directory used only by BlogFactory (CODEX_HOME=<dir> codex login)
ENGINE_CODEX_HOME=/var/lib/blogfactory/codex
ENGINE_CLAUDE_BIN=claude                # optional
ENGINE_CODEX_BIN=codex                  # optional
```

## Testing

- **Pure:** model-id parsing, argument lists (the isolation flags are pinned), and parsing the result envelope.
- **Router:** a fake spawner covering routing, fallback, the allow-list and the error kinds.
- **Live:** one real call through each CLI on the dev host, then one lindevo.com article with brief and draft on `claude-code:claude-opus-5-5`.
