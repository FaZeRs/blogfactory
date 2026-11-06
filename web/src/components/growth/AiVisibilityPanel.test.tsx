import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiVisibilityPanel } from "./AiVisibilityPanel";
import type { AiVisibilityState } from "@/lib/ai-visibility";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useSites", () => ({ useSites: () => ({ activeSite: { id: "s1" } }) }));

const settings = { enabled: true, questions: ["best crm for plumbers?"], engines: ["openai/gpt-5.6-luna"], weekday: 1, monthlyCapUsd: 5, brandTerms: ["Acme"] };
const check = { question: "best crm for plumbers?", engine: "openai/gpt-5.6-luna", engineLabel: "OpenAI", status: "ok", cited: false, citedUrls: [], mentioned: false, otherHosts: ["rival.com"], competitorHosts: ["rival.com"], answer: "Try Rival" };
const state = (over: Partial<AiVisibilityState> = {}): AiVisibilityState => ({
  available: true, running: false, settings,
  summary: {
    week: "2026-W45",
    latest: { questions: 4, answered: 4, citedQuestions: 1, share: 0.25, mentionedShare: 0.5, engines: [{ engine: "openai/gpt-5.6-luna", label: "OpenAI", asked: 4, cited: 1, share: 0.25 }] },
    trend: [{ week: "2026-W44", share: 0.1, answered: 4 }, { week: "2026-W45", share: 0.25, answered: 4 }],
    topCompetitors: [{ host: "rival.com", count: 3, flagged: true }],
    gaps: [{ question: "best crm for plumbers?", competitorHosts: ["rival.com"], otherHosts: [], twoWeeks: false }],
    checks: [check], costThisMonth: 0.12,
  },
  ...over,
});

async function mount(data: AiVisibilityState) {
  apiMocks.get.mockImplementation(async (path: string) => (path.includes("/models") ? { models: [{ id: "openai/gpt-5.6-luna", label: "GPT", searchPrice: 0.01 }] } : data));
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={client}><MemoryRouter><AiVisibilityPanel /></MemoryRouter></QueryClientProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}
const button = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("AiVisibilityPanel", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it("names the reason when unavailable", async () => {
    const el = await mount(state({ available: false, reason: "no_openrouter_key" }));
    expect(el.textContent).toContain("Add an OpenRouter API key");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows an empty state that opens the editor", async () => {
    const el = await mount(state({ settings: { ...settings, questions: [] } }));
    expect(el.textContent).toContain("Ask AI assistants");
    await act(async () => button(el, "Add questions")!.click());
    expect(document.body.textContent).toContain("AI answer check");
  });

  it("renders share, engines, competitors and gaps", async () => {
    const el = await mount(state());
    for (const t of ["25%", "1 of 4 questions cited", "OpenAI", "rival.com · 3", "Add as idea", "$0.12"]) expect(el.textContent).toContain(t);
    await act(async () => button(el, "Add as idea")!.click());
    expect(apiMocks.post).toHaveBeenCalledWith("/ai-visibility/gap-idea", { siteId: "s1", question: "best crm for plumbers?" });
  });

  it("disables Run now while running", async () => {
    const el = await mount(state({ running: true }));
    expect((button(el, "Running") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows server question errors in the settings dialog", async () => {
    const el = await mount(state());
    apiMocks.put.mockRejectedValue(Object.assign(new Error("Some questions need changes"), { indexErrors: [{ index: 0, message: "Too short" }] }));
    await act(async () => button(el, "Settings")!.click());
    await act(async () => button(document.body, "Save")!.click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("best crm for plumbers?: Too short");
  });
});
