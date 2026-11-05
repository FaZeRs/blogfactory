import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdeaCard } from "./IdeaCard";
import IdeasCalendar from "@/pages/IdeasCalendar";
import type { Idea } from "@/lib/ideas";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useSites", () => ({ useSites: () => ({ activeSite: { id: "s1" } }) }));

const idea: Idea = {
  id: "i1", siteId: "s1", status: "new", title: "Heat pump costs in 2027", angle: "Real numbers", primaryKeyword: "heat pump cost",
  alternateKeywords: [], searchIntent: "informational", audienceQuestion: null,
  brief: { whyNow: "New subsidy", outline: ["A", "B", "C"], informationGain: ["Own data"], sources: [], suggestedMode: "normal" },
  score: 72, scoreBreakdown: { trend: 0.8, fit: 0.7, demand: 0.6, feasibility: 0.5, novelty: 0.9, gain: 0.4, keyword: { volume: 1200, difficulty: 30, intent: "informational" }, nearestPost: { id: "p9", title: "Old post", similarity: 0.6 }, rationale: "Strong" },
  origin: "refresh", discoveryId: null, mode: "normal", scheduledFor: null, jobId: null, postId: null, rejectedReason: null, error: null, failedRuns: 0, createdAt: "", updatedAt: "",
};

async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}
const button = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("ideas", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it("renders the score breakdown, keyword data and similar post", async () => {
    const el = await mount(<IdeaCard idea={idea} />);
    for (const t of ["Trend", "Search demand", "Novelty", "volume 1200", "Similar to:", "Old post", "Refresh"]) expect(el.textContent).toContain(t);
    expect(el.querySelectorAll('[role="img"]')).toHaveLength(6);
  });

  it("renders an unscored manual idea with an empty brief, and a sitemap match as an external link", async () => {
    const el = await mount(<IdeaCard idea={{ ...idea, origin: "manual", brief: {}, score: null, scoreBreakdown: null }} />);
    expect(el.textContent).toContain("Not scored yet.");
    const page = await mount(<IdeaCard idea={{ ...idea, scoreBreakdown: { ...idea.scoreBreakdown!, nearestPost: { id: "https://s.example/old", title: "Sitemap page", similarity: 0.7 } } }} />);
    expect(page.querySelector('a[href="https://s.example/old"]')?.textContent).toBe("Sitemap page");
  });

  it("approves with the server-picked slot when no date is chosen", async () => {
    apiMocks.post.mockResolvedValue({ idea: { ...idea, scheduledFor: "2027-01-05T08:00:00Z" } });
    const el = await mount(<IdeaCard idea={idea} />);
    await act(async () => button(el, "Approve")!.click());
    await act(async () => button(document.body, "Approve")!.click());
    const dialogApprove = [...document.body.querySelectorAll("button")].filter((b) => b.textContent === "Approve").pop()!;
    await act(async () => dialogApprove.click());
    expect(apiMocks.post).toHaveBeenCalledWith("/ideas/i1/approve", expect.objectContaining({ title: idea.title }));
    expect(apiMocks.post.mock.calls[0][1]).not.toHaveProperty("scheduledFor");
  });

  it("renders calendar slots", async () => {
    const d = new Date(); const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-10`;
    apiMocks.get.mockResolvedValue({ timezone: "UTC", slots: [
      { at: `${ds}T08:00:00Z`, localDate: ds, isCadenceSlot: true, idea: { id: "i1", title: "Planned idea", status: "scheduled", score: 70, mode: "normal", jobId: null, error: null }, post: null },
      { at: `${ds}T09:00:00Z`, localDate: ds, isCadenceSlot: true, idea: null, post: null },
    ] });
    const el = await mount(<IdeasCalendar />);
    expect(el.textContent).toContain("Planned idea");
    expect(el.textContent).toContain("Open slot");
  });
});
