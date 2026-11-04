import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoverPanel } from "./CoverPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = (canEdit: boolean) => ({
  cover: { path: "a", url: "/api/storage/a" },
  versions: [
    { id: "v1", path: "a", url: "/api/storage/a", source_kind: "ai" },
    { id: "v2", path: "b", url: "/api/storage/b", source_kind: "ai_edit" },
  ],
  pending: [], presets: [{ id: "custom", label: "Custom" }], default_preset: "custom",
  prompt_draft: "draft", prompt_drafts: { custom: "draft" }, image_model: "m", can_edit: canEdit, cost_per_image: 0.07,
});

async function mount(canEdit: boolean) {
  apiMocks.get.mockResolvedValue(state(canEdit));
  apiMocks.post.mockResolvedValue({ request_ids: ["r"] });
  apiMocks.put.mockResolvedValue({});
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    createRoot(el).render(<QueryClientProvider client={client}><MemoryRouter><CoverPanel postId="p1" disabled={false} /></MemoryRouter></QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("CoverPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("labels versions and switches on click", async () => {
    const el = await mount(true);
    expect(el.textContent).toContain("Generated");
    expect(el.textContent).toContain("Adjusted");
    await act(async () => button(el, "Adjusted")!.click());
    expect(apiMocks.put).toHaveBeenCalledWith("/images/posts/p1/cover", { asset_id: "v2" });
  });

  it("generates three covers with a cost label", async () => {
    const el = await mount(true);
    expect(el.textContent).toContain("Generate 3 · $0.21");
    await act(async () => button(el, "Generate 3")!.click());
    expect(apiMocks.post).toHaveBeenCalledWith("/images/posts/p1/cover", expect.objectContaining({ count: 3 }));
  });

  it("hides Adjust when the model cannot edit", async () => {
    expect((await mount(false)).querySelector('[aria-label="Adjust instruction"]')).toBeNull();
  });
});
