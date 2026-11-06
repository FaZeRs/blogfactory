import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { ReviseWithCommentsDialog } from "./ReviseWithCommentsDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: { post } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const onRevised = vi.fn();
const onReload = vi.fn();

async function open() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    createRoot(el).render(<QueryClientProvider client={client}><ReviseWithCommentsDialog postId="p1" updatedAt="2026-01-01T00:00:00.000Z" onRevised={onRevised} onReload={onReload} /></QueryClientProvider>);
  });
  await act(async () => el.querySelector("button")!.click());
}
const button = (text: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
async function type(value: string) {
  const area = document.body.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ReviseWithCommentsDialog", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it("needs real comments, shows Revising… while the call runs, then hands the post over", async () => {
    let finish!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => { finish = r; }));
    await open();
    expect(button("Revise")!.disabled).toBe(true);
    await type("Shorten the intro paragraph.");
    await act(async () => button("Revise")!.click());
    expect(post).toHaveBeenCalledWith("/posts/p1/revise-with-comments", { comments: "Shorten the intro paragraph.", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(button("Revising…")!.disabled).toBe(true);
    expect(document.body.querySelector("textarea")!.disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    const revised = { title: "T", content: "C", summary: null, coverImageUrl: null, inlineImages: null };
    await act(async () => finish(revised));
    expect(onRevised).toHaveBeenCalledWith(revised);
    expect(toast.success).toHaveBeenCalledWith("Revised; the previous version is in revisions");
  });

  it("offers a reload on a 409", async () => {
    post.mockRejectedValue(new ApiError("stale", 409, "conflict"));
    await open();
    await type("Add an example under pricing.");
    await act(async () => button("Revise")!.click());
    expect(document.body.textContent).toContain("This post changed since you opened it");
    expect(onRevised).not.toHaveBeenCalled();
    await act(async () => button("Reload post")!.click());
    expect(onReload).toHaveBeenCalled();
  });
});
