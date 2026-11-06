import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EngineLlm, EngineLlmRequest, EngineLlmResult } from "./llm.js";

/**
 * Subscription models through the vendors' own CLIs (spec 2026-11-06-subscription-models). A role's model id
 * `claude-code:<model>` or `codex:<model>` runs on the owner's Claude or ChatGPT subscription, with an optional
 * OpenRouter fallback after `|`. Prompts carry untrusted web text, so both CLIs run with every tool, plugin, hook
 * and user config switched off, in an empty working directory, with a minimal environment.
 */

export type SubscriptionProvider = "claude-code" | "codex";
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = ["claude-code", "codex"];

/** Model choices offered in the settings for each provider; each falls back to the same model on OpenRouter. */
export const SUBSCRIPTION_MODELS: Record<SubscriptionProvider, { id: string; name: string }[]> = {
  "claude-code": [
    { id: "claude-code:claude-opus-5-5|anthropic/claude-opus-5.5", name: "Claude Opus 5.5 (Claude subscription)" },
    { id: "claude-code:claude-sonnet-5-5|anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5 (Claude subscription)" },
    { id: "claude-code:claude-haiku-5-5|anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5 (Claude subscription)" },
  ],
  codex: [
    { id: "codex:gpt-6-sol|openai/gpt-6-sol", name: "GPT-6 Sol (ChatGPT subscription)" },
    { id: "codex:gpt-6-luna|openai/gpt-6-luna", name: "GPT-6 Luna (ChatGPT subscription)" },
  ],
};

export type ParsedModel = { provider: SubscriptionProvider | null; model: string; fallback: string | null };

export function parseModelId(id: string): ParsedModel {
  const [main = "", fallback] = id.split("|").map((s) => s.trim());
  const m = /^(claude-code|codex):(.+)$/.exec(main);
  return m ? { provider: m[1] as SubscriptionProvider, model: m[2]!, fallback: fallback || null } : { provider: null, model: main, fallback: fallback || null };
}

/** The providers this instance enables for this account: `ENGINE_SUBSCRIPTIONS` and the `ENGINE_SUBSCRIPTION_USERS` allow-list. */
export function subscriptionsFor(env: Record<string, string | undefined>, email: string | null | undefined): SubscriptionProvider[] {
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const users = list(env.ENGINE_SUBSCRIPTION_USERS);
  if (!email || !users.includes(email.trim().toLowerCase())) return [];
  return SUBSCRIPTION_PROVIDERS.filter((p) => list(env.ENGINE_SUBSCRIPTIONS).includes(p));
}

export class SubscriptionError extends Error {
  constructor(readonly kind: "not_enabled" | "unavailable" | "limit" | "timeout" | "bad_output", message: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

export type SpawnResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; notFound: boolean };
export type Spawner = (cmd: string, args: string[], opts: { env: Record<string, string>; cwd: string; stdin: string; timeoutMs: number; signal?: AbortSignal }) => Promise<SpawnResult>;

const MAX_OUTPUT = 4_000_000;

export const nodeSpawner: Spawner = (cmd, args, opts) => new Promise((resolve) => {
  let stdout = "", stderr = "", timedOut = false, settled = false;
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs);
  const onAbort = () => killGroup();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const done = (r: Omit<SpawnResult, "stdout" | "stderr" | "timedOut">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    resolve({ ...r, stdout, stderr, timedOut });
  };
  child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
  child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
  child.on("error", (e: NodeJS.ErrnoException) => done({ code: null, notFound: e.code === "ENOENT" }));
  child.on("close", (code) => done({ code, notFound: false }));
  child.stdin.on("error", () => {});
  child.stdin.end(opts.stdin);
});

/** The fixed Claude Code flags; the tests pin them. Matches Lindevo's engine-kit `claudeArgs`. */
export function claudeArgs(model: string, jsonSchema: string, systemPrompt: string): string[] {
  return [
    "-p", "--output-format", "json", "--json-schema", jsonSchema, "--model", model,
    "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--safe-mode",
    "--setting-sources", "project", "--settings", JSON.stringify({ disableAllHooks: true }),
    "--no-session-persistence", "--max-turns", "3", "--permission-mode", "dontAsk",
    "--system-prompt", systemPrompt,
  ];
}

/** The fixed Codex flags; the tests pin them. The shell tool, apps, plugins, browser, computer use and web search are off. */
export function codexArgs(model: string, schemaFile: string, outFile: string): string[] {
  return [
    "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
    "-c", "features.shell_tool=false", "-c", "features.apps=false", "-c", "features.plugins=false",
    "-c", "features.browser_use=false", "-c", "features.computer_use=false", "-c", 'web_search="disabled"',
    "-m", model, "--output-schema", schemaFile, "-o", outFile, "--json", "-",
  ];
}

const LIMIT_RE = /usage limit|rate limit|limit reached|quota|too many requests|429/i;
const AUTH_RE = /not logged in|login|unauthori[sz]ed|authenticat|401|403/i;

/** Only the vendor's short reason, never prompt text: the result text can quote the prompt. */
function failureKind(text: string): SubscriptionError["kind"] {
  return LIMIT_RE.test(text) ? "limit" : AUTH_RE.test(text) ? "unavailable" : "bad_output";
}

/** Reads the `claude -p --output-format json` envelope. */
export function parseClaudeEnvelope(stdout: string): unknown {
  let env: Record<string, unknown>;
  try { env = JSON.parse(stdout.trim()); } catch { throw new SubscriptionError("bad_output", "Claude Code returned no JSON envelope"); }
  if (env.is_error || env.subtype !== "success") {
    const why = typeof env.result === "string" ? env.result : String(env.subtype ?? "error");
    throw new SubscriptionError(failureKind(why), `Claude Code call failed (${failureKind(why)})`);
  }
  if (env.structured_output !== undefined) return env.structured_output;
  if (typeof env.result === "string") {
    try { return JSON.parse(env.result); } catch { /* fall through */ }
  }
  throw new SubscriptionError("bad_output", "Claude Code returned no structured output");
}

export type SubscriptionDeps = {
  env: Record<string, string | undefined>;
  /** The providers this account may use (`subscriptionsFor`). */
  allowed: readonly SubscriptionProvider[];
  spawner?: Spawner;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const LIMIT_KEYS = new Set(["minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const stripLimits = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stripLimits)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !LIMIT_KEYS.has(k)).map(([k, x]) => [k, stripLimits(x)]))
  : v;

/**
 * The request schema as JSON Schema, without the `$schema` draft URI Claude Code's validator rejects. `shapeOnly`
 * also drops length, count and pattern limits: Codex fails a schema that has them (the zod check still applies them).
 */
export function cliSchema(schema: z.ZodType, shapeOnly = false): string {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return JSON.stringify(shapeOnly ? stripLimits(rest) : rest);
}

async function workDir(): Promise<string> {
  const dir = join(tmpdir(), "blogfactory-subscription-work");
  await mkdir(dir, { recursive: true });
  return dir;
}

function baseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? tmpdir() };
  if (env.NODE_EXTRA_CA_CERTS) out.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
  return out;
}

async function runClaude<T>(req: EngineLlmRequest<T>, model: string, deps: SubscriptionDeps): Promise<unknown> {
  const env = { ...baseEnv(deps.env), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } as Record<string, string>;
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = deps.env.CLAUDE_CODE_OAUTH_TOKEN;
  const schema = cliSchema(req.schema);
  const r = await (deps.spawner ?? nodeSpawner)(deps.env.ENGINE_CLAUDE_BIN || "claude", claudeArgs(model, schema, req.system), {
    env, cwd: await workDir(), stdin: req.user, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: req.signal,
  });
  if (r.notFound) throw new SubscriptionError("unavailable", "Claude Code CLI is not installed on this host");
  if (r.timedOut) throw new SubscriptionError("timeout", "Claude Code call timed out");
  if (r.code !== 0 && !r.stdout.trim()) throw new SubscriptionError(failureKind(r.stderr), `Claude Code exited with ${r.code} (${failureKind(r.stderr)})`);
  return parseClaudeEnvelope(r.stdout);
}

async function runCodex<T>(req: EngineLlmRequest<T>, model: string, deps: SubscriptionDeps): Promise<unknown> {
  const home = deps.env.ENGINE_CODEX_HOME?.trim();
  if (!home) throw new SubscriptionError("unavailable", "ENGINE_CODEX_HOME is not set");
  const dir = await mkdtemp(join(tmpdir(), "blogfactory-codex-"));
  try {
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "out.json");
    await writeFile(schemaFile, cliSchema(req.schema, true));
    const r = await (deps.spawner ?? nodeSpawner)(deps.env.ENGINE_CODEX_BIN || "codex", codexArgs(model, schemaFile, outFile), {
      env: { ...baseEnv(deps.env), CODEX_HOME: home }, cwd: await workDir(),
      stdin: `${req.system}\n\n${req.user}`, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: req.signal,
    });
    if (r.notFound) throw new SubscriptionError("unavailable", "Codex CLI is not installed on this host");
    if (r.timedOut) throw new SubscriptionError("timeout", "Codex call timed out");
    const out = await readFile(outFile, "utf8").catch(() => "");
    if (r.code !== 0 || !out.trim()) {
      const events = r.stdout.split("\n").filter((l) => l.includes('"error"')).join(" ");
      throw new SubscriptionError(failureKind(`${events} ${r.stderr}`), `Codex call failed (${failureKind(`${events} ${r.stderr}`)})`);
    }
    try { return JSON.parse(out); } catch { throw new SubscriptionError("bad_output", "Codex returned no JSON"); }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Wraps the OpenRouter/gateway client: `claude-code:` and `codex:` model ids run on the subscription CLIs, anything else
 * goes to `base` unchanged. A subscription failure uses the `|fallback` model through `base` when one is named.
 */
export function withSubscriptions(base: EngineLlm, deps: SubscriptionDeps): EngineLlm {
  return {
    async json<T>(req: EngineLlmRequest<T>): Promise<EngineLlmResult<T>> {
      const parsed = parseModelId(req.model);
      if (!parsed.provider) return base.json({ ...req, model: parsed.model });
      try {
        if (!deps.allowed.includes(parsed.provider)) {
          throw new SubscriptionError("not_enabled", `${parsed.provider} models are not enabled for this account`);
        }
        const run = (r: EngineLlmRequest<T>) => (parsed.provider === "claude-code" ? runClaude(r, parsed.model!, deps) : runCodex(r, parsed.model!, deps));
        let checked = req.schema.safeParse(await run(req));
        if (!checked.success) {
          // One repair round, as the API client does: the issues name paths and limits, never prompt text.
          const issues = JSON.stringify(checked.error.issues.slice(0, 20));
          checked = req.schema.safeParse(await run({ ...req, user: `${req.user}\n\nYour previous reply failed schema validation. Reply again with the whole JSON corrected for these issues:\n${issues}` }));
        }
        if (!checked.success) throw new SubscriptionError("bad_output", `${parsed.provider} reply failed the schema`);
        return { value: checked.data, model: `${parsed.provider}:${parsed.model}`, promptTokens: 0, completionTokens: 0, costUsd: 0 };
      } catch (error) {
        if (req.signal?.aborted) throw error;
        if (parsed.fallback) return base.json({ ...req, model: parsed.fallback });
        throw error;
      }
    },
  };
}
