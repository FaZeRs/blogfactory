// Vendored from Lindevo packages/mdx/src/component-spec.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
/**
 * The single source of truth for every markdown component an article may use:
 * its tag, attributes, nesting, per-article limits and EN/LV labels.
 *
 * No React here on purpose, so tooling that never renders (linting, docs,
 * prompts) can import it without pulling in the component tree.
 */

/**
 * The five kinds of system the site sells: the section anchors on /services,
 * the articles' CTA vocabulary and the content engine's Service select.
 */
export const SERVICE_IDS = [
  "save-time",
  "make-money",
  "agent-teams",
  "research",
  "full-systems",
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** The /services anchors are the service ids. */
export const CAPABILITY_IDS = SERVICE_IDS;
export type CapabilityId = ServiceId;

/**
 * The three ids the site sold before the five lines. Published articles and
 * old Notion rows still carry them, so they are read as the line that now
 * covers them and never written.
 */
export const LEGACY_SERVICE_IDS = ["knowledge", "tools", "workflows"] as const;
export type LegacyServiceId = (typeof LEGACY_SERVICE_IDS)[number];

export const LEGACY_SERVICE_ALIAS: Record<LegacyServiceId, ServiceId> = {
  knowledge: "save-time",
  tools: "full-systems",
  workflows: "save-time",
};

/** A current or legacy service id as the current one; anything else is null. */
export function toServiceId(value: unknown): ServiceId | null {
  if (SERVICE_IDS.some((id) => id === value)) {
    return value as ServiceId;
  }
  return LEGACY_SERVICE_IDS.some((id) => id === value)
    ? LEGACY_SERVICE_ALIAS[value as LegacyServiceId]
    : null;
}

export const PAIN_POINT_IDS = [
  "customer-questions",
  "sales-follow-ups",
  "document-processing",
  "team-handoffs",
  "recurring-reports",
  "internal-knowledge",
] as const;
export type PainPointId = (typeof PAIN_POINT_IDS)[number];

export const WORKFLOW_STEP_KINDS = [
  "trigger",
  "ai",
  "human",
  "output",
] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const CALLOUT_VARIANTS = [
  "default",
  "info",
  "success",
  "warning",
  "error",
  "danger",
] as const;

export const ARTICLE_CATEGORIES = [
  "getting-started",
  "system-design",
  "operations",
] as const;

export const MDX_LOCALES = ["en", "lv"] as const;
export type MdxLocale = (typeof MDX_LOCALES)[number];

/** Where `provenance` links when the article does not override it. */
export const DEFAULT_CASE_STUDY_PATH = "/projects/blog-engine";

export type AttrSpec =
  | {
      type: "string";
      required?: boolean;
      maxLength?: number;
      /** A required value that may still be blank. Only an image's alt. */
      allowEmpty?: boolean;
    }
  | {
      type: "enum";
      values: readonly string[];
      /** Retired values still accepted on read and never documented. */
      aliases?: readonly string[];
      required?: boolean;
    }
  | { type: "int"; required?: boolean; min?: number }
  | { type: "date"; required?: boolean }
  | { type: "csv"; required?: boolean }
  | { type: "boolean"; required?: boolean };

export interface ComponentSpec {
  attrs: Record<string, AttrSpec>;
  body: "markdown" | "none" | "text";
  children?: readonly string[];
  description: string;
  example: string;
  kind: "container" | "leaf";
  labels?: { en: Record<string, string>; lv: Record<string, string> };
  maxCount?: number;
  parents?: readonly string[];
  tag: string;
}

/**
 * Plain HTML an article may still contain. Anything else is a typo or leaked
 * code. `figure`/`figcaption` are left out on purpose: the component map turns
 * `figcaption` into the code-block header.
 */
export const PLAIN_HTML_ALLOWLIST: readonly string[] = [
  "a",
  "abbr",
  "blockquote",
  "br",
  "del",
  "details",
  "em",
  "hr",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const SERVICE_CTA_LABELS = {
  en: {
    action: "See how we build it",
    actionExample: "See the worked example",
    "agent-teams.eyebrow": "Agent teams",
    "agent-teams.text":
      "Several AI agents with clear roles work one job together, each within its own limits and budget.",
    "agent-teams.title": "A team that does the work.",
    "full-systems.eyebrow": "Full systems",
    "full-systems.text":
      "The agents, models, data and integrations, built and run as one system.",
    "full-systems.title": "The whole system, built end to end.",
    "make-money.eyebrow": "Make money",
    "make-money.text":
      "A system that finds and qualifies leads and keeps follow-ups moving, so less revenue slips away.",
    "make-money.title": "More from the leads you already have.",
    "research.eyebrow": "Research",
    "research.text":
      "A research agent that watches markets, competitors and tenders and returns briefs where every claim has a source.",
    "research.title": "Research you have no time for, done.",
    "save-time.eyebrow": "Save time",
    "save-time.text":
      "The replies, entries and reports that come back every day get prepared for your team, within limits you set.",
    "save-time.title": "Hand over the work that keeps coming back.",
  },
  lv: {
    action: "Skatīt, kā mēs to veidojam",
    actionExample: "Skatīt piemēru",
    "agent-teams.eyebrow": "Aģentu komandas",
    "agent-teams.text":
      "Vairāki MI aģenti ar skaidrām lomām kopā veic vienu darbu, katrs savu ierobežojumu un budžeta robežās.",
    "agent-teams.title": "Komanda, kas paveic darbu.",
    "full-systems.eyebrow": "Pilnas sistēmas",
    "full-systems.text":
      "Aģenti, modeļi, dati un integrācijas, izveidoti un uzturēti kā viena sistēma.",
    "full-systems.title": "Visa sistēma no sākuma līdz galam.",
    "make-money.eyebrow": "Pelniet vairāk",
    "make-money.text":
      "Sistēma, kas atrod un novērtē potenciālos klientus un neļauj sekojošajiem soļiem apstāties, lai mazāk ieņēmumu paslīd garām.",
    "make-money.title": "Vairāk no klientiem, kas Jums jau ir.",
    "research.eyebrow": "Izpēte",
    "research.text":
      "Izpētes aģents seko tirgiem, konkurentiem un iepirkumiem un sagatavo kopsavilkumus, kur katram apgalvojumam ir avots.",
    "research.title": "Izpēte, kurai Jums nav laika, paveikta.",
    "save-time.eyebrow": "Ietaupiet laiku",
    "save-time.text":
      "Atbildes, ieraksti un atskaites, kas atkārtojas katru dienu, tiek sagatavoti Jūsu komandai Jūsu noteiktajās robežās.",
    "save-time.title": "Nododiet darbu, kas atgriežas atkal un atkal.",
  },
};

const PROVENANCE_LABELS = {
  en: {
    caseStudy: "See how the process works",
    checks: "Automated checks passed",
    intro:
      "Drafted by our content system from checked sources, then reviewed and approved by a person before it was published.",
    manualTerm: "Human review",
    manualValue: "Approved manually",
    models: "Drafted with",
    reviewer: "Reviewed and approved by",
    sources: "Sources checked",
    title: "How this article was made",
  },
  lv: {
    caseStudy: "Kā darbojas šis process",
    checks: "Izturētas automātiskās pārbaudes",
    intro:
      "Melnrakstu sagatavoja mūsu satura sistēma, balstoties uz pārbaudītiem avotiem, un pirms publicēšanas to pārskatīja un apstiprināja cilvēks.",
    manualTerm: "Cilvēka pārbaude",
    manualValue: "Apstiprināts manuāli",
    models: "Melnraksts sagatavots ar",
    reviewer: "Pārskatīja un apstiprināja",
    sources: "Pārbaudīti avoti",
    title: "Kā tapa šis raksts",
  },
};

export const COMPONENT_SPEC: Readonly<Record<string, ComponentSpec>> = {
  callout: {
    attrs: { variant: { type: "enum", values: CALLOUT_VARIANTS } },
    body: "markdown",
    description:
      "A boxed note. Leave a blank line inside the tags if the body uses markdown.",
    example:
      '<callout variant="info">\nOne short note for the reader.\n</callout>',
    kind: "container",
    labels: {
      en: {
        danger: "Danger",
        default: "Note",
        error: "Error",
        info: "Info",
        success: "Success",
        warning: "Warning",
      },
      lv: {
        danger: "Bīstami",
        default: "Piezīme",
        error: "Kļūda",
        info: "Informācija",
        success: "Izdevās",
        warning: "Brīdinājums",
      },
    },
    tag: "callout",
  },
  "case-chart": {
    attrs: {
      id: { required: true, type: "string" },
      locale: { type: "enum", values: MDX_LOCALES },
    },
    body: "none",
    description:
      "A chart from packages/mdx/src/case-study-data.ts, by dataset id. Case studies only.",
    example:
      '<case-chart id="pukarags-reservations-monthly" locale="en"></case-chart>',
    kind: "leaf",
    tag: "case-chart",
  },
  "case-stat": {
    attrs: {
      after: { type: "string" },
      before: { type: "string" },
      change: { type: "string" },
      direction: { type: "enum", values: ["up-good", "down-good"] },
      hint: { type: "string" },
      label: { required: true, type: "string" },
      value: { type: "string" },
    },
    body: "none",
    description:
      "One result inside case-stats: before/after with an optional change chip, or a plain value.",
    example: '<case-stat label="Posts shipped" value="37"></case-stat>',
    kind: "leaf",
    parents: ["case-stats"],
    tag: "case-stat",
  },
  "case-stats": {
    attrs: {},
    body: "none",
    children: ["case-stat"],
    description: "A grid of case-stat results.",
    example:
      '<case-stats>\n<case-stat label="Booked nights" before="138" after="503" change="+264%"></case-stat>\n</case-stats>',
    kind: "container",
    tag: "case-stats",
  },
  file: {
    attrs: { name: { required: true, type: "string" } },
    body: "none",
    description: "One file in a files tree.",
    example: '<file name="index.ts"></file>',
    kind: "leaf",
    parents: ["files", "folder"],
    tag: "file",
  },
  files: {
    attrs: {},
    body: "none",
    children: ["folder", "file"],
    description: "A file tree for code walkthroughs.",
    example:
      '<files>\n<folder name="src" open>\n<file name="index.ts"></file>\n</folder>\n</files>',
    kind: "container",
    tag: "files",
  },
  folder: {
    attrs: {
      name: { required: true, type: "string" },
      open: { type: "boolean" },
    },
    body: "none",
    children: ["folder", "file"],
    description: "A folder in a files tree.",
    example:
      '<folder name="src" open>\n<file name="index.ts"></file>\n</folder>',
    kind: "container",
    parents: ["files", "folder"],
    tag: "folder",
  },
  Image: {
    attrs: {
      // Empty for a decorative image, as with plain markdown images.
      alt: { allowEmpty: true, required: true, type: "string" },
      caption: { type: "string" },
      height: { min: 1, type: "int" },
      src: { required: true, type: "string" },
      width: { min: 1, type: "int" },
    },
    body: "none",
    description:
      "A zoomable image with an optional caption. Prefer plain markdown images.",
    example:
      '<Image src="/images/blog/x.webp" alt="What the image shows"></Image>',
    kind: "leaf",
    tag: "Image",
  },
  "key-takeaways": {
    attrs: {},
    body: "markdown",
    description:
      "The article's 3 to 5 key points as a markdown list, near the top. At most one per article.",
    example:
      "<key-takeaways>\n\n- First takeaway in one sentence.\n- Second takeaway.\n- Third takeaway.\n\n</key-takeaways>",
    kind: "container",
    labels: {
      en: { title: "Key takeaways" },
      lv: { title: "Galvenais īsumā" },
    },
    maxCount: 1,
    tag: "key-takeaways",
  },
  provenance: {
    attrs: {
      "case-study": { type: "string" },
      checks: { min: 0, required: true, type: "int" },
      models: { type: "csv" },
      reviewed: { required: true, type: "date" },
      reviewer: { maxLength: 80, type: "string" },
      sources: { min: 0, required: true, type: "int" },
    },
    body: "none",
    description:
      "How the article was made: sources, checks, reviewer, models. A reviewer name is optional: without one the box says the article was approved manually. The last block of the article. Numbers come from the engine's records, never from a model.",
    example:
      '<provenance sources="14" checks="23" reviewed="2026-10-03" models="Claude Opus 5.5, GPT-6, Gemini 3.5"></provenance>',
    kind: "leaf",
    labels: PROVENANCE_LABELS,
    maxCount: 1,
    tag: "provenance",
  },
  "service-cta": {
    attrs: {
      anchor: { type: "enum", values: PAIN_POINT_IDS },
      service: {
        aliases: LEGACY_SERVICE_IDS,
        required: true,
        type: "enum",
        values: SERVICE_IDS,
      },
      text: { maxLength: 160, type: "string" },
      title: { maxLength: 80, type: "string" },
    },
    body: "none",
    description:
      "One link to the service (or pain-point example) the article is about. At most one per article.",
    example:
      '<service-cta service="save-time" anchor="sales-follow-ups"></service-cta>',
    kind: "leaf",
    labels: SERVICE_CTA_LABELS,
    maxCount: 1,
    tag: "service-cta",
  },
  step: {
    attrs: {},
    body: "text",
    description:
      "A step title inside steps. The step's body is the markdown that follows it.",
    example: "<step>Export the calendar</step>",
    kind: "leaf",
    parents: ["steps"],
    tag: "step",
  },
  steps: {
    attrs: {},
    body: "markdown",
    children: ["step"],
    description:
      "A numbered sequence: each <step>Title</step> followed by its body.",
    example:
      "<steps>\n<step>First step</step>\n\nWhat to do first.\n\n<step>Second step</step>\n\nWhat to do next.\n</steps>",
    kind: "container",
    tag: "steps",
  },
  tour: {
    attrs: { title: { maxLength: 80, type: "string" } },
    body: "markdown",
    children: ["tour-step"],
    description:
      "A clickable walkthrough built from 2 to 8 tour-step children: a step list beside one panel at a time. Every step's text stays in the page for search engines. Case studies only.",
    example:
      '<tour title="How an article is made">\n\n<tour-step kind="trigger" title="Signals collected" image="/images/projects/x/signals.webp" alt="Topic board with scored topics">\nEvery Monday the system reads public news and search data.\n</tour-step>\n\n<tour-step kind="human" title="Person approves">\nAn editor reads the preview and approves it.\n</tour-step>\n\n</tour>',
    kind: "container",
    labels: {
      en: { figure: "Walkthrough" },
      lv: { figure: "Apskats" },
    },
    maxCount: 1,
    tag: "tour",
  },
  "tour-step": {
    attrs: {
      alt: { type: "string" },
      image: { type: "string" },
      kind: { type: "enum", values: WORKFLOW_STEP_KINDS },
      title: { maxLength: 80, required: true, type: "string" },
    },
    body: "markdown",
    description:
      "One step of a tour: a title, an optional screenshot (image + alt; the alt falls back to the title) and its text. `kind` adds the workflow-step badge.",
    example:
      '<tour-step kind="ai" title="Draft written" image="/images/projects/x/draft.webp" alt="Draft with a source marker on each sentence">\nThe draft marks every factual sentence with its source.\n</tour-step>',
    kind: "container",
    parents: ["tour"],
    tag: "tour-step",
  },
  workflow: {
    attrs: { title: { maxLength: 80, type: "string" } },
    body: "markdown",
    children: ["workflow-step"],
    description:
      "A diagram of how work moves, built from 2 to 8 workflow-step children.",
    example:
      '<workflow title="Order email to reviewed sheet row">\n\n<workflow-step kind="trigger" title="Order email arrives">\nShared inbox receives the supplier email.\n</workflow-step>\n\n<workflow-step kind="human" title="Team member checks">\nSomeone approves or corrects before saving.\n</workflow-step>\n\n</workflow>',
    kind: "container",
    labels: {
      en: { figure: "Workflow" },
      lv: { figure: "Darba plūsma" },
    },
    tag: "workflow",
  },
  "workflow-step": {
    attrs: {
      kind: { required: true, type: "enum", values: WORKFLOW_STEP_KINDS },
      title: { maxLength: 80, required: true, type: "string" },
    },
    body: "markdown",
    description:
      "One step of a workflow: trigger, ai (prepared by the system), human (checked by a person) or output.",
    example:
      '<workflow-step kind="ai" title="Fields extracted">\nThe system reads the order lines and prepares a row.\n</workflow-step>',
    kind: "container",
    labels: {
      en: {
        ai: "Prepared by the system",
        human: "Checked by a person",
        output: "Result",
        trigger: "Trigger",
      },
      lv: {
        ai: "Sagatavo sistēma",
        human: "Pārbauda cilvēks",
        output: "Rezultāts",
        trigger: "Sākums",
      },
    },
    parents: ["workflow"],
    tag: "workflow-step",
  },
  Youtube: {
    attrs: { id: { required: true, type: "string" } },
    body: "none",
    description: "An embedded YouTube video by id.",
    example: '<Youtube id="dQw4w9WgXcQ"></Youtube>',
    kind: "leaf",
    tag: "Youtube",
  },
};

const SPEC_BY_LOWER = new Map(
  Object.values(COMPONENT_SPEC).map((spec) => [spec.tag.toLowerCase(), spec])
);

/** HTML parsers lowercase tag names, so lookups ignore case. */
export function getComponentSpec(name: string): ComponentSpec | undefined {
  return SPEC_BY_LOWER.get(name.toLowerCase());
}

export function isMdxLocale(
  value: string | null | undefined
): value is MdxLocale {
  return MDX_LOCALES.some((locale) => locale === value);
}

/** A component's label in the served locale, falling back to English, then the key. */
export function specLabel(tag: string, key: string, locale: MdxLocale): string {
  const labels = COMPONENT_SPEC[tag]?.labels;
  return labels?.[locale][key] ?? labels?.en[key] ?? key;
}
