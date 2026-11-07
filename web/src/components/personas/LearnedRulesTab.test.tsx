import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LearnedRulesTab } from "./LearnedRulesTab";
import type { RulesByStatus, StyleRule } from "@/lib/learning";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const rule = (over: Partial<StyleRule>): StyleRule => ({
  id: "r1", scope: "draft", rule: "Write 'use', not 'utilize'.", rationale: "Replaced in three edits", op: "add", targetRuleId: null, status: "proposed",
  evidence: [{ signalId: "a", kind: "edit", locale: null, excerpt: "utilize -> use" }, { signalId: "b", kind: "comment", locale: null, excerpt: "Say use" }],
  eval: null, createdAt: "", decidedAt: null, ...over,
});
const data: RulesByStatus = {
  proposed: [
    rule({}),
    rule({ id: "r2", scope: "translation:lv", rule: "Use formal address.", rationale: "Comments", eval: null }),
    rule({ id: "r3", rule: "Never open with a question.", eval: { status: "done", winRate: 0.67, meanDelta: 0.4, dims: {}, wins: 2, losses: 1, ties: 0, briefs: 3, costUsd: 0.1, finishedAt: "" } }),
  ],
  approved: [rule({ id: "a1", status: "approved", rule: "Keep paragraphs short." })],
  retired: [rule({ id: "x1", status: "retired", rule: "Old retired rule." })],
  rejected: [rule({ id: "x2", status: "rejected", rule: "Rejected idea." })],
};

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={client}><LearnedRulesTab siteId="s1" /></QueryClientProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}
const buttons = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
const click = async (b: Element | undefined) => { await act(async () => { (b as HTMLButtonElement).click(); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("learned rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    apiMocks.get.mockImplementation(async (path: string) => (path.startsWith("/learning/rules") ? data : { enabled: false, lastDistillAt: null, signals: 7 }));
    apiMocks.post.mockResolvedValue({});
    apiMocks.put.mockResolvedValue({});
  });

  it("shows proposals with scope, rationale, evidence and the eval result", async () => {
    const el = await mount();
    for (const t of ["Write 'use', not 'utilize'.", "English drafts", "Latvian translation", "Replaced in three edits", "utilize -> use", "Say use", "win rate 67%", "7 corrections in the last 28 days"]) expect(el.textContent).toContain(t);
    expect(el.textContent).toContain("Keep paragraphs short.");
    // a translation proposal has no eval button: there is no translation suite
    expect(buttons(el, "Test with evals")).toHaveLength(2);
  });

  it("approves, rejects and tests a proposal", async () => {
    const el = await mount();
    await click(buttons(el, "Approve")[0]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/rules/r1/approve", {});
    await click(buttons(el, "Reject")[1]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/rules/r2/reject", {});
    await click(buttons(el, "Test with evals")[0]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/rules/r1/eval", {});
  });

  it("edits a rule before approving it", async () => {
    const el = await mount();
    await click(buttons(el, "Edit and approve")[0]);
    const box = el.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("Write 'use', not 'utilize'.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Write 'use'.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(el, "Save and approve")[0]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/rules/r1/approve", { rule: "Write 'use'." });
  });

  it("retires an approved rule, collapses retired and rejected ones, and switches learning on", async () => {
    const el = await mount();
    await click(buttons(el, "Retire")[0]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/rules/a1/retire", {});
    expect(el.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(el.querySelector("details")?.textContent).toContain("Old retired rule.");
    await click(el.querySelector('button[role="switch"]')!);
    expect(apiMocks.put).toHaveBeenCalledWith("/learning/settings?siteId=s1", { enabled: true });
    await click(buttons(el, "Suggest rules")[0]);
    expect(apiMocks.post).toHaveBeenCalledWith("/learning/distill?siteId=s1", {});
  });
});
