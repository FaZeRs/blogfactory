import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeaSourcesCard } from "./IdeasSettings";
import type { IdeaSources } from "@/lib/ideas";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const empty: IdeaSources = { feeds: [], hn: { queries: [], minPoints: 20 }, subreddits: [], pages: [], seen: { "https://p.test/blog": ["https://p.test/blog/a"] } };
let latest: IdeaSources;

function Harness({ initial }: { initial: IdeaSources }) {
  const [v, setV] = useState(initial);
  latest = v;
  return <IdeaSourcesCard value={v} onChange={setV} />;
}

const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const press = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("IdeaSourcesCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.restoreAllMocks(); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("shows saved sources", () => {
    act(() => root.render(<Harness initial={{ ...empty, feeds: ["https://a.test/feed"], subreddits: ["webdev"], pages: [{ url: "https://p.test/blog", pattern: "/blog/" }] }} />));
    expect(host.textContent).toContain("https://a.test/feed");
    expect(host.textContent).toContain("webdev");
    expect(host.textContent).toContain("contains /blog/");
  });

  it("adds a feed and a watched page with a pattern, rejects a private URL, and keeps the seen links", () => {
    act(() => root.render(<Harness initial={empty} />));
    const feed = host.querySelector<HTMLInputElement>("#src-feeds")!;
    act(() => type(feed, "http://192.168.0.1/feed"));
    expect(host.textContent).toContain("Enter a public http(s) URL.");
    act(() => type(feed, "a.test/feed.xml"));
    act(() => press(feed, "Enter"));
    expect(latest.feeds).toEqual(["https://a.test/feed.xml"]);

    const page = host.querySelector<HTMLInputElement>("#src-pages")!;
    act(() => type(page, "https://p.test/blog"));
    act(() => type(host.querySelector<HTMLInputElement>("[aria-label='Link pattern']")!, "/blog/"));
    act(() => press(page, "Enter"));
    expect(latest.pages).toEqual([{ url: "https://p.test/blog", pattern: "/blog/" }]);
    expect(latest.seen).toEqual(empty.seen);

    act(() => type(host.querySelector<HTMLInputElement>("#src-hn-points")!, "50"));
    expect(latest.hn.minPoints).toBe(50);
    act(() => host.querySelector<HTMLButtonElement>("[aria-label='Remove https://a.test/feed.xml']")!.click());
    expect(latest.feeds).toEqual([]);
  });
});
