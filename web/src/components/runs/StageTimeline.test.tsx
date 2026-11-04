import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { StageTimeline } from "./StageTimeline";

const base = { attempt: 1, model: "m/x", costUsd: 0, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:05Z", error: null };

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StageTimeline", () => {
  it("renders one row per stage attempt with cost and error", () => {
    const host = document.createElement("div");
    act(() => {
      createRoot(host).render(
      <StageTimeline
        stages={[
          { ...base, stage: "research", status: "succeeded", costUsd: 0.12 },
          { ...base, stage: "brief", status: "succeeded" },
          { ...base, stage: "draft", status: "failed", error: "Provider timed out" },
        ]}
      />,
      );
    });
    expect(host.querySelectorAll("li")).toHaveLength(3);
    expect(host.textContent).toContain("$0.12");
    expect(host.textContent).toContain("Provider timed out");
  });
});
