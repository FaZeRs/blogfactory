import { COMPONENT_SPEC, PAIN_POINT_IDS, SERVICE_IDS, type AttrSpec, type ComponentSpec } from "./component-spec.js";

// Ported from Lindevo apps/content-engine/src/prompts/components.ts (2026-11-05), without the sha helper.

/**
 * Tags the writer may use. Left out on purpose: `provenance` (code adds it at delivery), the case-study
 * tags (they claim results the writer has no evidence for), `Youtube` and `Image`.
 */
export const ENGINE_COMPONENT_TAGS = ["key-takeaways", "workflow", "workflow-step", "service-cta", "callout", "steps", "step"] as const;
/** What the brief may plan: the writer adds `service-cta` from the brief's service choice. */
export const BRIEF_COMPONENT_TAGS = ENGINE_COMPONENT_TAGS.filter((t) => t !== "service-cta");

export const SERVICES = SERVICE_IDS;
export const PAIN_POINTS = PAIN_POINT_IDS;

function attrKind(a: AttrSpec): string {
  switch (a.type) {
    case "enum": return `one of ${a.values.join(" | ")}`;
    case "string": return a.maxLength ? `string ≤ ${a.maxLength} chars` : "string";
    case "int": return a.min === undefined ? "whole number" : `whole number ≥ ${a.min}`;
    case "date": return "date written YYYY-MM-DD";
    case "csv": return "comma-separated list";
    case "boolean": return "flag, written as the bare name";
    default: return "value";
  }
}

function attrText(name: string, a: AttrSpec): string {
  const need = a.required ? (a.type === "string" && a.allowEmpty ? "required, may be empty" : "required") : "optional";
  return `\`${name}\` (${attrKind(a)}, ${need})`;
}

const BODY: Record<ComponentSpec["body"], string> = { markdown: "markdown", none: "none (nothing between the tags)", text: "plain text" };

function describe(s: ComponentSpec): string {
  const attrs = Object.entries(s.attrs).map(([n, a]) => attrText(n, a));
  const facts = [
    `Kind: ${s.kind}`,
    `body: ${BODY[s.body]}`,
    s.parents ? `only inside ${s.parents.map((p) => `<${p}>`).join(", ")}` : "",
    s.children ? `children: ${s.children.map((c) => `<${c}>`).join(", ")}` : "",
    s.maxCount ? `at most ${s.maxCount} per article` : "",
  ].filter(Boolean);
  return [`### <${s.tag}>`, s.description, `${facts.join("; ")}.`, `Attributes: ${attrs.length ? attrs.join(", ") : "none"}.`, "Example:", "```md", s.example, "```"].join("\n");
}

function bodyRules(specs: readonly ComponentSpec[]): string[] {
  const rules: string[] = [];
  for (const s of specs) {
    if (s.kind === "leaf" && s.body === "none") {
      rules.push(`- <${s.tag}> takes no body: write <${s.tag} …></${s.tag}> with nothing between the tags, because text there is dropped. Put words in its attributes or in the article around it.`);
    } else if (s.tag === "steps") {
      rules.push("- <steps> must open with a <step> title: any text before the first <step> is dropped. Write every title exactly as <step>Title</step>, lowercase and with nothing else inside the tags. The markdown after a title is that step's body.");
    } else if (s.kind === "container" && s.children) {
      const kids = s.children.map((c) => `<${c}>`).join(" or ");
      rules.push(`- <${s.tag}> holds only ${kids} blocks: no prose, list or heading directly inside it, before, between or after them.`);
    }
  }
  return rules;
}

/** Markdown reference generated from the vendored component spec, so prompts never drift from the linter. */
export function componentGuide(tags: readonly string[] = ENGINE_COMPONENT_TAGS): string {
  const specs = tags.map((tag) => {
    const s = COMPONENT_SPEC[tag];
    if (!s) throw new Error(`component-spec has no <${tag}>`);
    return s;
  });
  const rules = [
    "Component rules (the linter rejects anything else):",
    "- Every top-level component starts its own line, with a blank line before and after it. A container's opening tag stands alone on its line, with its content starting on the next line.",
    "- Every tag is explicitly closed (no self-closing tags) and written exactly as in the examples.",
    "- Attribute values are double-quoted. Enum attributes accept only the listed values, and a required attribute is never empty.",
    "- No headings inside components. Do not invent tags or attributes.",
    ...bodyRules(specs),
  ];
  return [rules.join("\n"), ...specs.map(describe)].join("\n\n");
}

export const anchorAttr = (painPoint: string | null | undefined) => (painPoint && painPoint !== "none" ? ` anchor="${painPoint}"` : "");
/** The exact call-to-action tag for a service (and optional pain point). */
export const serviceCtaTag = (service: string, painPoint?: string | null) => `<service-cta service="${service}"${anchorAttr(painPoint)}></service-cta>`;

export const MARKDOWN_COMPONENTS = "Plain Markdown only. No HTML or custom tags.";

/** The brief's `{{components}}`: the guide for what it may plan, and how to choose the service. */
export function briefComponents(lindevo: boolean): string {
  if (!lindevo) return MARKDOWN_COMPONENTS;
  return [
    "The destination renders these components. Plan them in the `purpose` of the outline section that uses them:",
    "- `key-takeaways`: once, near the top (the writer wraps your takeaways in it).",
    "- `workflow`: only when the article explains a process of 2–8 steps.",
    "- `callout`: for a single caution or limit.",
    "- `steps`: for a short how-to.",
    "Do not plan `service-cta` or `provenance`: the writer adds the call to action from your service choice, and code adds provenance.",
    "",
    `Also set \`service\` to the one service the article leads to (${SERVICES.join(" | ")}), or "none" when none fits honestly. Set \`painPoint\` (${PAIN_POINTS.join(" | ")}) when the article is about one of them, otherwise "none". Both fields are required.`,
    "",
    componentGuide(BRIEF_COMPONENT_TAGS),
  ].join("\n");
}

/** The writer's `{{components}}` (draft and revise): the guide plus where each component goes. */
export function writerComponents(lindevo: boolean, hasCta: boolean): string {
  if (!lindevo) return MARKDOWN_COMPONENTS;
  return [
    "The destination renders these components. Use them exactly as described and nowhere else.",
    "- Right after the opening, put the brief's takeaways inside `<key-takeaways>` as a 3–5 item markdown list (exactly one `key-takeaways`).",
    "- Use components as the brief plans them. A process of 2–8 steps becomes one `<workflow>` with `<workflow-step>` children; a single caution is a `<callout>`; a short how-to is `<steps>`.",
    hasCta ? "- Exactly one `service-cta`, before the FAQ, exactly as given below." : "- Do not write a `service-cta`.",
    "- No provenance block, no H1, no section called \"Conclusion\", no links to cal.com. The FAQ stays last.",
    "",
    componentGuide(ENGINE_COMPONENT_TAGS),
  ].join("\n");
}
