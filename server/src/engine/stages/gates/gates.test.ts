import { expect, test } from "bun:test";
import { loadPrompt } from "../../prompts/load.js";
import { lengthInstruction } from "../revise/index.js";
import { checkLink } from "./index.js";

const reply = (status: number) => (async () => new Response(null, { status })) as never;

test("checkLink returns the HEAD status, falls back to GET on 405, and maps failures", async () => {
  expect(await checkLink("https://a.example", undefined, reply(200))).toBe(200);
  const methods: string[] = [];
  const picky = (async (_u: string, init: { method: string }) => {
    methods.push(init.method);
    return new Response(null, { status: init.method === "HEAD" ? 405 : 200 });
  }) as never;
  expect(await checkLink("https://a.example", undefined, picky)).toBe(200);
  expect(methods).toEqual(["HEAD", "GET"]);
  expect(await checkLink("https://a.example", undefined, (async () => { throw new Error("dns"); }) as never)).toBe(0);
  const timeout = (async () => { throw new DOMException("t", "TimeoutError"); }) as never;
  expect(await checkLink("https://a.example", undefined, timeout)).toBe(408);
});

test("revise length instruction puts a too-long article first; the prompt has every variable it needs", async () => {
  expect(lengthInstruction(3000)).toStartWith("FIRST PRIORITY");
  expect(lengthInstruction(100)).toContain("too short");
  const t = await loadPrompt("revise");
  expect(t.user).toContain("{{blockers}}");
  expect(t.system).toContain("House style");
});
