import { expect, test } from "bun:test";
import { isBoilerplateTitle, mapLimit, sanitizeText, sha256Hex, truncate } from "./util";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("truncate keeps short text, cuts long text to exactly max, and never exceeds max", () => {
  expect(truncate("hello", 5)).toBe("hello");
  expect(truncate("hello", 10)).toBe("hello");
  const cut = truncate("hello world", 6);
  expect(cut).toBe("hello…");
  expect(cut.length).toBe(6);
  expect(truncate("hello", 1)).toBe("…");
  expect(truncate("hello", 0)).toBe("");
  expect(truncate("hello", -3)).toBe("");
  expect(truncate("", 0)).toBe("");
});

test("mapLimit keeps result order regardless of completion order", async () => {
  const delays = [30, 5, 20, 1, 10];
  const out = await mapLimit(delays, 3, async (ms, i) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `${i}:${ms}`;
  });
  expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
});

test("mapLimit never exceeds the concurrency bound, and reaches it", async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapLimit(items, 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  });
  expect(peak).toBe(3);
});

test("mapLimit handles empty input and a limit larger than the list", async () => {
  expect(await mapLimit([], 4, (x) => Promise.resolve(x))).toEqual([]);
  expect(await mapLimit([1, 2], 10, (x) => Promise.resolve(x * 2))).toEqual([
    2, 4,
  ]);
});

test("mapLimit propagates a rejection", async () => {
  await expect(
    mapLimit([1, 2, 3], 2, (x) =>
      x === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(x)
    )
  ).rejects.toThrow("boom");
});

test("mapLimit starts no new item after a rejection", async () => {
  const started: number[] = [];
  await expect(
    mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (x) => {
      started.push(x);
      if (x === 0) {
        throw new Error("boom");
      }
      await sleep(15);
      return x;
    })
  ).rejects.toThrow("boom");
  // Give the surviving worker time to (wrongly) keep draining the queue.
  await sleep(60);
  expect(started).toEqual([0, 1]);
});

test("mapLimit rejects a limit below 1 without calling fn", async () => {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  await expect(mapLimit([1, 2], 0, fn)).rejects.toThrow(RangeError);
  await expect(mapLimit([1, 2], -1, fn)).rejects.toThrow(RangeError);
  await expect(mapLimit([1, 2], Number.NaN, fn)).rejects.toThrow(RangeError);
  expect(calls).toBe(0);
});

// ---------- text that is stored or sent ----------
const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xd8_3d);
const LOW = String.fromCharCode(0xde_00);
const EMOJI = HIGH + LOW;
const REPLACEMENT = String.fromCharCode(0xff_fd);
// Not typed by the project's tsc lib (ES2022); the runtime (Bun, Node 20+) has it.
const wellFormed = (s: string) =>
  (s as string & { isWellFormed: () => boolean }).isWellFormed();
const toWellFormed = (s: string) =>
  (s as string & { toWellFormed: () => string }).toWellFormed();

test("truncate never splits a surrogate pair and never exceeds max", () => {
  const text = `ab${EMOJI}cd${EMOJI}${EMOJI}e`;
  for (let max = 0; max <= text.length + 2; max += 1) {
    const out = truncate(text, max);
    expect(out.length).toBeLessThanOrEqual(Math.max(max, 0));
    expect(wellFormed(out)).toBe(true);
    if (text.length > max && max > 0) {
      expect(out.endsWith("…")).toBe(true);
    }
  }
  // The cut falls between the halves of the emoji: the whole emoji is dropped, not half of it.
  expect(truncate(`${"x".repeat(498)}${EMOJI}tail`, 500)).toBe(
    `${"x".repeat(498)}…`
  );
  // A cut that lands after a whole pair keeps it.
  expect(truncate(`${"x".repeat(497)}${EMOJI}tail`, 500)).toBe(
    `${"x".repeat(497)}${EMOJI}…`
  );
});

test("truncate leaves a surrogate that was already lone for sanitizeText to deal with", () => {
  expect(truncate(`${HIGH}abcdef`, 4)).toBe(`${HIGH}ab…`);
});

test("sanitizeText strips U+0000 and replaces every lone surrogate", () => {
  expect(sanitizeText(`a${NUL}b${NUL}`)).toBe("ab");
  expect(sanitizeText(`x${HIGH}y`)).toBe(`x${REPLACEMENT}y`);
  expect(sanitizeText(`x${LOW}y`)).toBe(`x${REPLACEMENT}y`);
  expect(sanitizeText(`x${LOW}${HIGH}y`)).toBe(
    `x${REPLACEMENT}${REPLACEMENT}y`
  );
  expect(sanitizeText(`end${HIGH}`)).toBe(`end${REPLACEMENT}`);
  // Whole pairs, plain text, Latvian and the empty string are untouched.
  expect(sanitizeText(`ok ${EMOJI} Rīga šķūnis`)).toBe(
    `ok ${EMOJI} Rīga šķūnis`
  );
  expect(sanitizeText("")).toBe("");
});

test("sanitizeText agrees with String.prototype.toWellFormed", () => {
  for (const s of [
    `${HIGH}${HIGH}${LOW}`,
    `${LOW}${LOW}`,
    `${EMOJI}${HIGH}`,
    `${HIGH}${NUL}${LOW}`,
  ]) {
    expect(sanitizeText(s)).toBe(toWellFormed(s.replaceAll(NUL, "")));
  }
});

test("sha256Hex is hex sha256", () => {
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("isBoilerplateTitle flags chrome, URLs and generic section words only", () => {
  expect(isBoilerplateTitle("We use cookies")).toBe(true);
  expect(isBoilerplateTitle("Just a moment...")).toBe(true);
  expect(isBoilerplateTitle("https://example.com/a")).toBe(true);
  expect(isBoilerplateTitle("See also:")).toBe(true);
  expect(isBoilerplateTitle("How retries shape a queue")).toBe(false);
});
