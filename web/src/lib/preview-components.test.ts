import { expect, test } from "vitest";
import { componentsToMarkdown } from "./preview-components";

test("component tags become labelled Markdown blocks", () => {
  const out = componentsToMarkdown([
    "<key-takeaways>\n\n- One\n- Two\n\n</key-takeaways>",
    '<workflow title="Flow">\n\n<workflow-step kind="ai" title="Draft">\nThe system drafts.\n</workflow-step>\n\n</workflow>',
    "<callout>\nCareful.\n</callout>",
    "<steps>\n<step>First</step>\n\nDo it.\n</steps>",
    '<service-cta service="save-time" anchor="team-handoffs"></service-cta>',
    '<provenance sources="3" checks="9" reviewed="2026-11-05"></provenance>',
  ].join("\n\n"));
  expect(out).not.toMatch(/<\/?(key-takeaways|workflow|callout|steps?|service-cta|provenance)/);
  expect(out).toContain("> **Key takeaways**");
  expect(out).toContain("> - One");
  expect(out).toContain("1. **Draft** (ai): The system drafts.");
  expect(out).toContain("> **Note**");
  expect(out).toContain("**Step 1. First**");
  expect(out).toContain("save-time / team-handoffs");
  expect(out).toContain("3 sources, 9 checks");
});
