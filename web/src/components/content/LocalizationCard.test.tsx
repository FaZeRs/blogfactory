import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalizationCard } from "./LocalizationCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const button = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(text) || b.getAttribute("aria-label")?.includes(text));

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function render(settings: unknown) {
  api.get.mockResolvedValue({ settings });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocalizationCard siteId="s1" /></QueryClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => { api.get.mockReset(); api.put.mockReset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); root = null; container = null; });

describe("LocalizationCard", () => {
  it("starts off with no languages, and saves a new language with its glossary, style guide and forbidden forms", async () => {
    await render({ enabled: false, locales: [] });
    expect(container!.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    await act(async () => { container!.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    await act(async () => { button("Add language")!.click(); });
    await type(container!.querySelector("#loc-code-0")!, "lv");
    await type(container!.querySelector("#loc-name-0")!, "Latvian");
    await act(async () => { button("Add term")!.click(); });
    await type(container!.querySelector('[aria-label="Glossary source 1"]')!, "dashboard");
    await type(container!.querySelector('[aria-label="Glossary target 1"]')!, "informācijas panelis");
    await type(container!.querySelector("#loc-style-0")!, "Formal tone.");
    const forbidden = container!.querySelector<HTMLInputElement>("#loc-forbidden-0")!;
    await type(forbidden, "tu, tev");
    await act(async () => { forbidden.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    api.put.mockResolvedValue({ settings: { enabled: true, locales: [] } });
    await act(async () => { button("Save")!.click(); });
    expect(api.put).toHaveBeenCalledWith("/settings/localization", { siteId: "s1", settings: {
      enabled: true,
      locales: [{ locale: "lv", name: "Latvian", glossary: [{ source: "dashboard", target: "informācijas panelis" }], styleGuide: "Formal tone.", formalAddress: { forbidden: ["tu", "tev"] } }],
    } });
  });

  it("blocks saving a language with a bad code", async () => {
    await render({ enabled: true, locales: [{ locale: "lv", name: "Latvian", glossary: [], styleGuide: "" }] });
    await type(container!.querySelector("#loc-code-0")!, "latvian");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    expect(container!.textContent).toContain("unique code");
  });

  it("caps the languages at three", async () => {
    await render({ enabled: true, locales: ["lv", "de", "fr"].map((locale) => ({ locale, name: locale, glossary: [], styleGuide: "" })) });
    expect((button("Add language") as HTMLButtonElement).disabled).toBe(true);
  });
});
