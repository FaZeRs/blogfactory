import assert from "node:assert/strict";
import { z } from "zod";
import { RateLimitError } from "../types.js";
import { createEngineLlm, engineAiEndpoint } from "./llm.js";
import { createFakeLlm } from "./fake-llm.js";

const or = engineAiEndpoint({}, "sk-or");
assert.deepEqual(or, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", gateway: "openrouter" });
assert.deepEqual(
  engineAiEndpoint({ ENGINE_AI_BASE_URL: "http://litellm:4000/v1", ENGINE_AI_API_KEY: "k" }, "sk-or"),
  { baseUrl: "http://litellm:4000/v1", apiKey: "k", gateway: "custom" },
);
assert.equal(engineAiEndpoint({ ENGINE_AI_BASE_URL: "http://x/v1" }, "sk-or"), null);
assert.equal(engineAiEndpoint({}, null), null);

const schema = z.object({ title: z.string() });
const req = { role: "brief" as const, model: "m", system: "s", user: "u", schema, maxTokens: 100 };
const reply = (content: string, usage: object = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ model: "m2", choices: [{ message: { content } }], usage }), { headers });

function stub(responses: Response[]) {
  const bodies: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as any).authorization });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { bodies, llm: createEngineLlm(or!, fetchImpl) };
}

{
  const { bodies, llm } = stub([reply('{"title":"a"}', { prompt_tokens: 3, completion_tokens: 4, cost: 0.002 })]);
  const r = await llm.json(req);
  assert.deepEqual(r, { value: { title: "a" }, model: "m2", promptTokens: 3, completionTokens: 4, costUsd: 0.002 });
  assert.equal(bodies[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(bodies[0].auth, "Bearer sk-or");
  assert.equal(bodies[0].body.response_format.json_schema.name, "brief");
  assert.equal(bodies[0].body.response_format.json_schema.strict, true);
  assert.deepEqual(bodies[0].body.usage, { include: true });
}
{
  const { llm } = stub([reply('{"title":"a"}', {}, { "x-litellm-response-cost": "0.5" })]);
  assert.equal((await llm.json(req)).costUsd, 0.5);
  const none = stub([reply('{"title":"a"}')]);
  assert.equal((await none.llm.json(req)).costUsd, 0);
}
{
  const { llm } = stub([new Response("", { status: 429, headers: { "retry-after": "7" } })]);
  await assert.rejects(llm.json(req), (e: any) => e instanceof RateLimitError && e.retryAfterMs === 7000);
}
{
  const { bodies, llm } = stub([reply("not json", { cost: 0.01 }), reply('{"title":"ok"}', { cost: 0.01 })]);
  const r = await llm.json(req);
  assert.deepEqual(r.value, { title: "ok" });
  assert.equal(bodies.length, 2);
  assert.equal(r.costUsd, 0.02);
}
{
  const { bodies, llm } = stub([reply('{"title":1}'), reply('{"nope":true}')]);
  await assert.rejects(llm.json(req), (e: any) => e.constructor === Error && /schema/.test(e.message));
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].body.messages.at(-1).content, /title/);
}
{
  // A code block inside a JSON string is article text, not a fence around the reply.
  const article = JSON.stringify({ title: "Intro\n```python\nprint(1)\n```\nend" });
  const raw = stub([reply(article)]);
  assert.equal((await raw.llm.json(req)).value.title, "Intro\n```python\nprint(1)\n```\nend");
  const fenced = stub([reply(`Here it is:\n\`\`\`json\n${article}\n\`\`\``)]);
  assert.equal((await fenced.llm.json(req)).value.title, "Intro\n```python\nprint(1)\n```\nend");
}
{
  // A failed call carries what its paid replies cost.
  const bad = stub([reply("not json", { cost: 0.03 }), reply("still not json", { cost: 0.04 })]);
  await assert.rejects(bad.llm.json(req), (e: any) => Math.abs(e.costUsd - 0.07) < 1e-9);
  const late = stub([reply("not json", { cost: 0.03 }), new Response("", { status: 429 })]);
  await assert.rejects(late.llm.json(req), (e: any) => e instanceof RateLimitError && Math.abs(e.costUsd - 0.03) < 1e-9);
}
{
  const fake = createFakeLlm({ brief: [{ title: "x" }] });
  assert.deepEqual((await fake.json(req)).value, { title: "x" });
  assert.equal(fake.calls.length, 1);
  await assert.rejects(fake.json(req), /no reply left/);
}
console.log("engine llm self-check passed");
