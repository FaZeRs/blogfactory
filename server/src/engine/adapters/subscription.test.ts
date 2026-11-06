import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { EngineLlm } from "./llm.js";
import { SubscriptionError, claudeArgs, codexArgs, nodeSpawner, parseClaudeEnvelope, parseModelId, subscriptionsFor, withSubscriptions, type Spawner } from "./subscription.js";

const schema = z.object({ title: z.string() });
const req = { role: "brief" as const, model: "", system: "SYSTEM", user: "USER", schema, maxTokens: 100 };
const base = (calls: string[]): EngineLlm => ({
  json: async (r) => { calls.push(r.model); return { value: { title: "from base" } as never, model: r.model, promptTokens: 1, completionTokens: 1, costUsd: 0.01 }; },
});

test("model ids: provider prefix and optional fallback", () => {
  expect(parseModelId("claude-code:claude-opus-5-5|anthropic/claude-opus-5.5")).toEqual({ provider: "claude-code", model: "claude-opus-5-5", fallback: "anthropic/claude-opus-5.5" });
  expect(parseModelId("codex:gpt-6-sol")).toEqual({ provider: "codex", model: "gpt-6-sol", fallback: null });
  expect(parseModelId("anthropic/claude-sonnet-5.5")).toEqual({ provider: null, model: "anthropic/claude-sonnet-5.5", fallback: null });
});

test("subscriptions need the provider list and the account on the allow-list", () => {
  const env = { ENGINE_SUBSCRIPTIONS: "claude-code, codex", ENGINE_SUBSCRIPTION_USERS: "Owner@Example.com" };
  expect(subscriptionsFor(env, "owner@example.com")).toEqual(["claude-code", "codex"]);
  expect(subscriptionsFor(env, "someone@example.com")).toEqual([]);
  expect(subscriptionsFor({ ENGINE_SUBSCRIPTIONS: "codex" }, "owner@example.com")).toEqual([]);
});

test("the isolation flags are pinned: no tools, no MCP, no hooks or user config, no shell", () => {
  const c = claudeArgs("claude-opus-5-5", "{}", "SYS");
  for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) expect(c).toContain(flag);
  expect(c[c.indexOf("--tools") + 1]).toBe("");
  expect(c[c.indexOf("--setting-sources") + 1]).toBe("project");
  expect(c[c.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  const x = codexArgs("gpt-6-sol", "/s.json", "/o.json");
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "features.shell_tool=false", 'web_search="disabled"']) expect(x).toContain(flag);
  expect(x[x.indexOf("--sandbox") + 1]).toBe("read-only");
});

test("the Claude envelope: structured output, a JSON result, and usage limits", () => {
  expect(parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { title: "a" } }))).toEqual({ title: "a" });
  expect(parseClaudeEnvelope(JSON.stringify({ subtype: "success", is_error: false, result: '{"title":"b"}' }))).toEqual({ title: "b" });
  expect(() => parseClaudeEnvelope(JSON.stringify({ subtype: "success", is_error: true, result: "Claude AI usage limit reached" })))
    .toThrow(expect.objectContaining({ kind: "limit" }) as never);
  expect(() => parseClaudeEnvelope("not json")).toThrow(SubscriptionError);
});

test("routing: subscription ids go to the CLI at no cost; others and fallbacks go to the base client", async () => {
  const calls: string[] = [];
  const seen: { cmd: string; stdin: string; env: Record<string, string> }[] = [];
  const spawner: Spawner = async (cmd, args, opts) => {
    seen.push({ cmd, stdin: opts.stdin, env: opts.env });
    if (cmd === "claude") return { code: 0, stdout: JSON.stringify({ subtype: "success", is_error: false, structured_output: { title: "from claude" } }), stderr: "", timedOut: false, notFound: false };
    await writeFile(args[args.indexOf("-o") + 1]!, JSON.stringify({ title: "from codex" }));
    return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  };
  const llm = withSubscriptions(base(calls), { env: { PATH: "/bin", HOME: "/h", ENGINE_CODEX_HOME: "/codex", SECRET_KEY: "x" }, allowed: ["claude-code", "codex"], spawner });
  const claude = await llm.json({ ...req, model: "claude-code:claude-opus-5-5" });
  expect([claude.value, claude.costUsd, claude.model]).toEqual([{ title: "from claude" }, 0, "claude-code:claude-opus-5-5"]);
  expect(seen[0]!.stdin).toBe("USER");
  expect(Object.keys(seen[0]!.env).sort()).toEqual(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER", "HOME", "PATH"]);
  const codex = await llm.json({ ...req, model: "codex:gpt-6-sol" });
  expect(codex.value).toEqual({ title: "from codex" });
  expect(seen[1]!.env.CODEX_HOME).toBe("/codex");
  expect(seen[1]!.env.SECRET_KEY).toBeUndefined();
  await llm.json({ ...req, model: "anthropic/claude-sonnet-5.5" });
  expect(calls).toEqual(["anthropic/claude-sonnet-5.5"]);
});

test("a failed or not-allowed subscription call uses the fallback, or throws without one", async () => {
  const calls: string[] = [];
  const limit: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ subtype: "success", is_error: true, result: "usage limit reached" }), stderr: "", timedOut: false, notFound: false });
  const llm = withSubscriptions(base(calls), { env: {}, allowed: ["claude-code"], spawner: limit });
  expect((await llm.json({ ...req, model: "claude-code:opus|anthropic/claude-opus-5.5" })).value).toEqual({ title: "from base" });
  await expect(llm.json({ ...req, model: "claude-code:opus" })).rejects.toThrow(/Claude Code call failed \(limit\)/);
  await expect(llm.json({ ...req, model: "codex:gpt-6-sol" })).rejects.toThrow(/not enabled/);
  const missing: Spawner = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true });
  await expect(withSubscriptions(base([]), { env: {}, allowed: ["claude-code"], spawner: missing }).json({ ...req, model: "claude-code:opus" })).rejects.toThrow(/not installed/);
  expect(calls).toEqual(["anthropic/claude-opus-5.5"]);
});

test("Codex gets the schema shape only; a reply that breaks a limit gets one repair round", async () => {
  const { cliSchema } = await import("./subscription.js");
  const s = z.object({ title: z.string().max(10), tags: z.array(z.string()).min(2) });
  expect(cliSchema(s)).toContain('"maxLength":10');
  expect(cliSchema(s, true)).not.toMatch(/maxLength|minItems|\$schema/);
  // Strict structured output needs every property required; a property may be named like a limit keyword.
  expect(cliSchema(z.object({ a: z.string(), format: z.string().optional() }), true)).toContain('"required":["a","format"]');
  const replies = [{ title: "far too long a title" }, { title: "short" }];
  const stdins: string[] = [];
  const spawner: Spawner = async (_cmd, _args, opts) => {
    stdins.push(opts.stdin);
    return { code: 0, stdout: JSON.stringify({ subtype: "success", is_error: false, structured_output: replies.shift() }), stderr: "", timedOut: false, notFound: false };
  };
  const llm = withSubscriptions(base([]), { env: {}, allowed: ["claude-code"], spawner });
  const r = await llm.json({ ...req, schema: z.object({ title: z.string().max(10) }), model: "claude-code:opus" });
  expect(r.value).toEqual({ title: "short" });
  expect(stdins[1]).toContain("failed schema validation");
});

test("the spawner keeps multi-byte text whole and never starts a call whose signal is already aborted", async () => {
  const opts = { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, cwd: "/", stdin: "", timeoutMs: 10_000 };
  const r = await nodeSpawner(process.execPath, ["-e", "process.stdout.write('x' + '\u2014'.repeat(200000))"], opts);
  expect(r.stdout.length).toBe(200_001);
  expect(r.stdout.includes("\uFFFD")).toBe(false);
  const started = Date.now();
  expect((await nodeSpawner("sleep", ["5"], { ...opts, signal: AbortSignal.abort() })).code).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});

test("roles naming a subscription the account may not use are reported", async () => {
  const { disallowedSubscriptionRoles } = await import("./subscription.js");
  const models = { brief: "claude-code:claude-opus-5-5|anthropic/claude-opus-5.5", draft: "codex:gpt-6-sol", revise: "anthropic/claude-sonnet-5.5" };
  expect(disallowedSubscriptionRoles(models, ["claude-code"])).toEqual(["draft"]);
  expect(disallowedSubscriptionRoles(models, ["claude-code", "codex"])).toEqual([]);
  expect(disallowedSubscriptionRoles(models, [])).toEqual(["brief", "draft"]);
});

test("a usage limit with no fallback waits like a 429; with a fallback it switches", async () => {
  const { RateLimitError } = await import("../types.js");
  const { LIMIT_WAIT_MS } = await import("./subscription.js");
  const limit: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ subtype: "success", is_error: true, result: "Claude AI usage limit reached" }), stderr: "", timedOut: false, notFound: false });
  const llm = withSubscriptions(base([]), { env: {}, allowed: ["claude-code"], spawner: limit });
  const err = await llm.json({ ...req, model: "claude-code:opus" }).catch((e) => e);
  expect(err).toBeInstanceOf(RateLimitError);
  expect(err.retryAfterMs).toBe(LIMIT_WAIT_MS);
  const missing: Spawner = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true });
  expect(await withSubscriptions(base([]), { env: {}, allowed: ["claude-code"], spawner: missing }).json({ ...req, model: "claude-code:opus" }).catch((e) => e)).not.toBeInstanceOf(RateLimitError);
});
