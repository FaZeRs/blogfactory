import { lintArticle } from "../components/lint.js";
import { maskCode } from "../markdown/mask-code.js";
import { type GateIssue, type GateResult, gateResult } from "./types.js";

const TAG_RE = (tag: string) => new RegExp(`<${tag}\\b([^>]*)>\\s*</${tag}>`, "g");
const ATTR_RE = /([a-z-]+)="([^"]*)"/g;
const FAQ_RE = /^## Frequently Asked Questions/m;

/** The call to action the brief chose: `service` null means none was chosen and none may be written. */
export type ComponentsExpectation = { service: string | null; painPoint: string | null };

/**
 * Lindevo profile only. Every lint error of the vendored Lindevo linter becomes a blocker naming its
 * rule and line; then the structure checks of Lindevo's own gate: exactly one `key-takeaways`, the
 * chosen `service-cta` (one, before the FAQ) or none. H1 and provenance are the `structure` gate's.
 */
export function componentsGate(markdown: string, expected: ComponentsExpectation): GateResult {
  const issues: GateIssue[] = lintArticle({ en: markdown }).issues
    .filter((i) => i.severity === "error")
    .map((i) => ({ message: `line ${i.line}: ${i.rule}: ${i.message}`, ...(i.hint ? { hint: i.hint } : {}) }));
  const md = maskCode(markdown);
  const takeaways = (md.match(/<key-takeaways>/g) ?? []).length;
  if (takeaways !== 1) issues.push({ message: `expected one <key-takeaways> right after the opening, found ${takeaways}` });

  const ctas = [...md.matchAll(TAG_RE("service-cta"))];
  if (!expected.service) {
    if (ctas.length > 0) issues.push({ message: "no service was chosen, so the article must not contain a <service-cta>" });
  } else if (ctas.length !== 1) {
    issues.push({ message: `expected exactly one <service-cta>, found ${ctas.length}`, hint: "keep exactly one service-cta before the FAQ, exactly as given" });
  } else {
    const attrs = Object.fromEntries([...(ctas[0]![1] ?? "").matchAll(ATTR_RE)].map((m) => [m[1], m[2]]));
    if (attrs.service !== expected.service) issues.push({ message: `service-cta has service="${attrs.service}" but the brief chose "${expected.service}"` });
    if ((expected.painPoint ?? undefined) !== attrs.anchor) issues.push({ message: `service-cta anchor is "${attrs.anchor ?? "(none)"}" but the brief chose "${expected.painPoint ?? "(none)"}"` });
    const faq = FAQ_RE.exec(md);
    if (faq && ctas[0]!.index > faq.index) issues.push({ message: "the <service-cta> must come before the FAQ" });
  }
  return gateResult("components", issues);
}
