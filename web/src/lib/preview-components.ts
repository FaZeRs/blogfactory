// Lindevo drafts hold component tags the preview's Markdown renderer would drop. This turns them into
// plain labelled Markdown blocks so the owner can read the draft; the CMS does the real rendering.
const attr = (attrs: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
const quote = (label: string, body: string) =>
  [`> **${label}**`, ">", ...body.trim().split("\n").map((l) => `> ${l}`.trimEnd())].join("\n");
const oneLine = (s: string) => s.trim().replace(/\s*\n\s*/g, " ");

export function componentsToMarkdown(md: string): string {
  return md
    .replace(/<key-takeaways>([\s\S]*?)<\/key-takeaways>/g, (_, body: string) => quote("Key takeaways", body))
    .replace(/<callout([^>]*)>([\s\S]*?)<\/callout>/g, (_, a: string, body: string) => {
      const variant = attr(a, "variant");
      return quote(variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : "Note", body);
    })
    .replace(/<workflow([^>]*)>([\s\S]*?)<\/workflow>/g, (_, a: string, body: string) => {
      const steps = [...body.matchAll(/<workflow-step([^>]*)>([\s\S]*?)<\/workflow-step>/g)]
        .map((m, i) => `${i + 1}. **${attr(m[1] ?? "", "title")}** (${attr(m[1] ?? "", "kind")}): ${oneLine(m[2] ?? "")}`);
      const title = attr(a, "title");
      return `**Workflow${title ? `: ${title}` : ""}**\n\n${steps.join("\n")}`;
    })
    .replace(/<steps>([\s\S]*?)<\/steps>/g, (_, body: string) => {
      let n = 0;
      return body.replace(/<step>([\s\S]*?)<\/step>/g, (_s, title: string) => `**Step ${++n}. ${oneLine(title)}**`).trim();
    })
    .replace(/<service-cta([^>]*)>\s*<\/service-cta>/g, (_, a: string) =>
      `> **Call to action (placeholder)**: ${attr(a, "service")}${attr(a, "anchor") ? ` / ${attr(a, "anchor")}` : ""}`)
    .replace(/<provenance([^>]*)>\s*<\/provenance>/g, (_, a: string) =>
      `*How this was made: ${attr(a, "sources")} sources, ${attr(a, "checks")} checks, reviewed ${attr(a, "reviewed")}.*`);
}
