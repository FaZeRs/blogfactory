import { expect, test } from "bun:test";
import { dropSourcesSection, toPlainText } from "./plain-text.js";

test("strips markup, any tag, code fences and the sources section", () => {
  const md = [
    "# Title",
    "",
    "Some **bold** [link](https://x.y) text.<br>Next <Callout kind=\"a\">inside</Callout> `<b>` kept.",
    "",
    "```ts",
    "const x = '<div>';",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "## Sources",
    "1. [One](https://one.example)",
    "",
    "## After",
    "tail",
  ].join("\n");
  const text = toPlainText(md);
  expect(text).toContain("Some bold link text.\nNext inside <b> kept.");
  expect(text).not.toContain("const x");
  expect(text).not.toContain("One");
  expect(text).toContain("1 2");
  expect(text).toContain("tail");
  expect(dropSourcesSection(md)).not.toContain("## Sources");
});
