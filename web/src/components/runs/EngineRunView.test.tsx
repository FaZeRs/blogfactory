import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EngineRunView } from "./EngineRunView";
import type { EngineRunDetail } from "@/lib/api";

const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, s)).toISOString();
const engine: EngineRunDetail = {
  run_id: "r", mode: "deep", state: "active", stage: "brief", spent_usd: 0.02, budget_usd: 5,
  stages: [
    {
      stage: "research", attempt: 1, status: "succeeded", model: "m", costUsd: 0.02, startedAt: at(0), finishedAt: at(88), error: null,
      details: { queries: ["crm small business"], searchAdapter: "searxng", sourceCount: 1, claimCount: 2, verifiedCount: 1 },
    },
    { stage: "brief", attempt: 1, status: "running", model: null, costUsd: 0, startedAt: at(90), finishedAt: null, error: null },
  ],
  sources: [{ id: "s1", url: "https://www.example.com/crm", title: "CRM guide", fetchedVia: "crawl4ai", httpStatus: 200, textLength: 900 }],
  evidence: [
    { claimId: "c1", sourceId: "s1", claim: "Most small firms use a CRM.", quote: "most small firms use a CRM", verified: true, method: "exact", reason: null },
    { claimId: "c2", sourceId: "s1", claim: "All firms use a CRM.", quote: "all firms", verified: false, method: null, reason: "quote_not_found" },
  ],
  gates: [],
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(over: Partial<EngineRunDetail> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  act(() => createRoot(el).render(<MemoryRouter><EngineRunView engine={{ ...engine, ...over }} /></MemoryRouter>));
  return el;
}
const click = (el: HTMLElement, text: string) => {
  const target = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  act(() => target!.click());
};

describe("EngineRunView", () => {
  it("summarises each stage and lists the steps still to come", () => {
    const el = mount();
    expect(el.textContent).toContain("1 sources read · 1 of 2 claims verified");
    expect(el.textContent).toContain("1m 28s");
    expect(el.textContent).toContain("Write");
    expect(el.textContent).toContain("$0.02 of $5.00 budget");
  });

  it("opens research to show sources and verified claims, with rejected ones on request", () => {
    const el = mount();
    click(el, "Research");
    expect(el.textContent).toContain("CRM guide");
    expect(el.textContent).toContain("Crawl4AI");
    expect(el.textContent).toContain("Most small firms use a CRM.");
    expect(el.textContent).not.toContain("All firms use a CRM.");
    click(el, "Show 1 rejected");
    expect(el.textContent).toContain("Rejected: quote not found");
  });

  it("shows the review stage with its own gate rows, apart from the quality checks", () => {
    const el = mount({
      state: "done",
      stages: [
        { stage: "gates", attempt: 1, status: "succeeded", model: null, costUsd: 0, startedAt: at(0), finishedAt: at(1), error: null, details: { passed: true } },
        { stage: "review", attempt: 1, status: "succeeded", model: "m", costUsd: 0.02, startedAt: at(2), finishedAt: at(9), error: null, details: { passed: false, blockerCount: 1, escalated: false } },
      ],
      gates: [
        { gate: "meta", attempt: 1, passed: true, severity: "blocker", issues: [], metrics: {} },
        { gate: "factcheck", attempt: 1, passed: false, severity: "blocker", issues: [{ message: "Claim is not supported by the evidence: \u201CX\u201D" }], metrics: {} },
      ],
    });
    expect(el.textContent).toContain("1 problem found · sent to revise");
    click(el, "Review");
    expect(el.textContent).toContain("Fact-check against the evidence");
    expect(el.textContent).toContain("Claim is not supported by the evidence");
    expect(el.textContent).not.toContain("Title, description and length");
  });
});
