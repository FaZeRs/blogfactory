import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareKitPanel } from "./ShareKitPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { get, post } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const kit = { linkedin: "A LinkedIn post.", thread: ["First post.", "Second post."], newsletter: "A blurb.", quotes: ["A quoted line from it."], teaser: "A teaser." };

async function render(unsaved = false) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={client}><ShareKitPanel postId="p1" unsaved={unsaved} /></QueryClientProvider>); });
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("ShareKitPanel", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it("creates a kit and shows every piece with a copy button", async () => {
    get.mockResolvedValue({ share_kit: null });
    post.mockResolvedValue({ share_kit: { kit, createdAt: "2026-11-07T00:00:00Z", stale: false } });
    const el = await render();
    await vi.waitFor(() => expect(button(el, "Create share kit")?.disabled).toBe(false));
    await act(async () => button(el, "Create share kit")!.click());
    expect(post).toHaveBeenCalledWith("/posts/p1/share-kit", {});
    await vi.waitFor(() => expect(el.textContent).toContain("A teaser."));
    for (const text of ["A LinkedIn post.", "Second post.", "A blurb.", "A quoted line from it.", "A teaser."]) expect(el.textContent).toContain(text);
    expect(el.querySelector("[aria-label='Copy Thread']")).toBeTruthy();
    expect(button(el, "Write again")).toBeTruthy();
  });

  it("warns when the kit is stale and waits for unsaved edits", async () => {
    get.mockResolvedValue({ share_kit: { kit, createdAt: "2026-11-07T00:00:00Z", stale: true } });
    const el = await render(true);
    await vi.waitFor(() => expect(el.textContent).toContain("The article changed after this kit was written"));
    expect(button(el, "Write again")!.disabled).toBe(true);
  });
});
