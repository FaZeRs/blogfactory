// Vendored from Lindevo packages/mdx/src/lint/parity.ts (copied 2026-11-05). Keep in sync with Lindevo; fix import paths only.
import { issueAt, type RawIssue } from "./issue.js";
import type { ComponentUse } from "./structure.js";

const PARITY_ATTRS = ["service", "anchor"] as const;
const DOC_START = { col: 1, line: 1 };

function nameOf(use: ComponentUse | undefined): string {
  return use ? `<${use.spec.tag}>` : "nothing";
}

/**
 * The Latvian article is an adaptation, not a different article: it uses the
 * same components in the same order and links to the same service. Issues are
 * reported against the Latvian text.
 */
export function lintParity(en: ComponentUse[], lv: ComponentUse[]): RawIssue[] {
  const length = Math.max(en.length, lv.length);
  for (let index = 0; index < length; index += 1) {
    const enUse = en[index];
    const lvUse = lv[index];
    if (enUse?.spec.tag !== lvUse?.spec.tag) {
      return [
        issueAt(
          lvUse?.open ?? DOC_START,
          "parity-components",
          `LV has ${nameOf(lvUse)} where EN has ${nameOf(enUse)} (component ${index + 1}).`,
          "EN and LV must use the same components in the same order."
        ),
      ];
    }
    for (const attr of PARITY_ATTRS) {
      const enValue = enUse?.open.attrs.get(attr);
      const lvValue = lvUse?.open.attrs.get(attr);
      if (enValue !== lvValue && lvUse) {
        return [
          issueAt(
            lvUse.open,
            "parity-attrs",
            `LV <${lvUse.spec.tag}> ${attr}="${String(lvValue ?? "")}" differs from EN "${String(enValue ?? "")}".`
          ),
        ];
      }
    }
  }
  return [];
}
