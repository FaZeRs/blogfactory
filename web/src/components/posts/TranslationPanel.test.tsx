import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationPanel } from "./TranslationPanel";
import { translationBadges, type PostTranslation } from "@/lib/localization";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/components/posts/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <textarea aria-label="Content" value={value} onChange={(e) => onChange(e.target.value)} />,
}));

const lv: PostTranslation = { locale: "lv", status: "ready", stale: false, title: "Nosaukums", slug: "nosaukums", description: "Apraksts", content: "Teksts", imageAlt: "", keyword: null, findings: [], updatedAt: "2026-11-07T10:00:00.000Z" };
const settings = { enabled: true, locales: [{ locale: "lv", name: "Latvian", glossary: [], styleGuide: "" }] };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function serve(opts: { settings?: unknown; translations?: PostTranslation[] }) {
  api.get.mockImplementation(async (path: string) => path.startsWith("/settings/localization")
    ? { settings: opts.settings ?? settings } : { translations: opts.translations ?? [] });
}

function Harness({ initial = "en" }: { initial?: string }) {
  const [locale, setLocale] = useState(initial);
  return <TranslationPanel postId="p1" siteId="s1" locale={locale} onLocale={setLocale} />;
}

async function render(initial = "en") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><Harness initial={initial} /></QueryClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const button = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.put.mockReset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); root = null; container = null; });

describe("TranslationPanel", () => {
  it("shows nothing when no language is enabled", async () => {
    serve({ settings: { enabled: false, locales: settings.locales } });
    await render();
    expect(container!.textContent).toBe("");
  });

  it("offers English plus each enabled language, and Translate when there is no translation", async () => {
    serve({});
    await render();
    expect([...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["English", "Latvian"]);
    await act(async () => { button("Latvian")!.click(); });
    expect(container!.textContent).toContain("Not translated yet");
    api.post.mockResolvedValue({ started: true });
    await act(async () => { button("Translate")!.click(); });
    expect(api.post).toHaveBeenCalledWith("/posts/p1/translations/lv/run");
  });

  it("shows Ready, Stale and Update translation for a stale translation", async () => {
    serve({ translations: [{ ...lv, stale: true }] });
    await render("lv");
    expect(container!.textContent).toContain("Ready");
    expect(container!.textContent).toContain("Stale");
    expect(button("Update translation")).toBeTruthy();
    expect((container!.querySelector("#tr-title") as HTMLInputElement).value).toBe("Nosaukums");
  });

  it("lists the findings of a translation that needs review", async () => {
    serve({ translations: [{ ...lv, status: "needs_review", findings: [{ gate: "formal", severity: "blocker", message: "Informal address", excerpt: "tu esi" }] }] });
    await render("lv");
    expect(container!.textContent).toContain("Needs review");
    expect(container!.textContent).toContain("Informal address");
    expect(container!.textContent).toContain("tu esi");
  });

  it("saves edits with the version it was opened at, and locks the form while running", async () => {
    serve({ translations: [lv] });
    api.put.mockResolvedValue({});
    await render("lv");
    const title = container!.querySelector("#tr-title") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Jauns");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Save")!.click(); });
    expect(api.put).toHaveBeenCalledWith("/posts/p1/translations/lv", expect.objectContaining({ title: "Jauns", expectedUpdatedAt: lv.updatedAt }));
  });

  it("disables the form and the button while a translation runs", async () => {
    serve({ translations: [{ ...lv, status: "running" }] });
    await render("lv");
    expect([...container!.querySelectorAll("button")].find((b) => b.textContent === "Translating")!.disabled).toBe(true);
    expect(container!.querySelector("fieldset")!.disabled).toBe(true);
  });

  it("badges", () => {
    expect(translationBadges({ ...lv, status: "edited", stale: true }).map((b) => b.label)).toEqual(["Edited", "Stale"]);
  });
});
