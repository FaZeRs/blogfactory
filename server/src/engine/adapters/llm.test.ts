import { expect, test } from "bun:test";
import { z } from "zod";
import { createEngineLlm } from "./llm.js";

const endpoint = { baseUrl: "https://llm.example/v1", apiKey: "k", gateway: "custom" as const };
const req = { role: "review" as const, model: "m", system: "s", user: "u", schema: z.object({ ok: z.boolean() }), maxTokens: 100 };
const reply = (body: unknown) => {
  const calls: unknown[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

test("a reply cut off at the token cap fails at once with the cap in the message", async () => {
  const { calls, fetchImpl } = reply({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: { cost: 0.001 } });
  await expect(createEngineLlm(endpoint, fetchImpl).json(req)).rejects.toThrow(/cut off at the 100-token limit/);
  expect(calls.length).toBe(1);
});

test("valid JSON is returned with its cost", async () => {
  const { fetchImpl } = reply({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { cost: 0.002 } });
  const r = await createEngineLlm(endpoint, fetchImpl).json(req);
  expect([r.value, r.costUsd]).toEqual([{ ok: true }, 0.002]);
});
