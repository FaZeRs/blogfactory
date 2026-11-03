import { describe, expect, it } from "vitest";
import { cmsDraftSuccessMessage, sourceHost, reviewDeliveryState, toolResultError } from "./review-card";

describe("MCP Review Card sources", () => {
  it("shows the host for http(s) links only", () => {
    expect(sourceHost("https://www.example.com/a?b=1")).toBe("example.com");
    expect(sourceHost("javascript:alert(1)")).toBeNull();
    expect(sourceHost("not a url")).toBeNull();
  });
});

describe("MCP Review Card delivery gate", () => {
  it("requires scope, clean blockers, and an explicit destination", () => {
    expect(reviewDeliveryState({ hasPermission: false, hasBlockers: false, destinationId: "cms" }).reason).toBe("read_only");
    expect(reviewDeliveryState({ hasPermission: true, hasBlockers: true, destinationId: "cms" }).reason).toBe("blocker");
    expect(reviewDeliveryState({ hasPermission: true, hasBlockers: false, destinationId: "" }).reason).toBe("destination_required");
    expect(reviewDeliveryState({ hasPermission: true, hasBlockers: false, destinationId: "cms" }).allowed).toBe(true);
  });

  it("reports deduplicated delivery without exposing provider data", () => {
    expect(cmsDraftSuccessMessage(true)).toBe("CMS draft ready. Existing draft reused.");
    expect(cmsDraftSuccessMessage(false)).toBe("CMS draft ready.");
  });

  it("reads safe structured conflicts and ignores unknown provider data", () => {
    expect(toolResultError({ structuredContent: { error: { code: "conflict", message: "Draft changed." }, next_action: "Reload review." } })).toEqual({ code: "conflict", message: "Draft changed.", nextAction: "Reload review." });
    expect(toolResultError({ provider: { token: "secret" } })).toBeNull();
  });
});
