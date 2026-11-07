import { type GateIssue, type GateResult, type GateInput, gateResult } from "./types.js";

/** Never echo a full secret: at most 4 characters, then an ellipsis. */
const mask = (s: string) => `${s.slice(0, 4)}…`;

interface LeakRule {
  allow?: (match: string, input: GateInput) => boolean;
  hint: string;
  message: string;
  re: RegExp;
  severity: "blocker" | "warning";
}

// A value that is plainly a stand-in: YOUR_API_KEY, xxxx, ****, <token>, ${VAR}, example/placeholder.
const PLACEHOLDER_RE = /x{4,}|\*{3,}|\.{3}|…|your[-_ ]|<[^>]*>|\$\{?\w|\{\{|example|placeholder|changeme|redacted|dummy|sample/i;
const EXAMPLE_HOST_RE = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
const KEBAB_VALUE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const siteHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
const ROLE_RE = /^(?:info|hello|contact|support|sales|team|press|help|office|admin|privacy|legal|billing)@/i;
// A real-looking assignment value has a letter and a digit (or is long); code like `password=getPassword()` does not.
const realValue = (v: string) => !PLACEHOLDER_RE.test(v) && /[A-Za-z]/.test(v) && (/\d/.test(v) || v.length >= 16) && !/[(){}]/.test(v);
// An unquoted `secret: word` is often prose ("The secret: cross-functional teams"), so it also needs a digit.
const secretAssignment = (m: string) => {
  const [, sep = "", quote = "", value = ""] = /[^:=]*?([:=])\s*(["']?)(.*)$/.exec(m) ?? [];
  return realValue(value) && (sep === "=" || quote !== "" || /\d/.test(value));
};
// Reserved example domains (RFC 2606); any other host with credentials is treated as real.
const RESERVED_HOST_RE = /^(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid)(?::\d+)?$/i;
const placeholderUrlCredentials = (m: string) => {
  const [, credentials = "", host = ""] = /^https?:\/\/([^@]+)@(.*)$/.exec(m) ?? [];
  return PLACEHOLDER_RE.test(credentials) || RESERVED_HOST_RE.test(host);
};

const RULES: readonly LeakRule[] = [
  // Provider tokens. A bare `sk-` keeps its word boundary so `risk-assessment-…` is not a key.
  { hint: "Remove the credential", message: "contains an API key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}|\bsk_live_[A-Za-z0-9]{10,}|\brk_live_[A-Za-z0-9]{10,}/g, severity: "blocker", allow: (m) => PLACEHOLDER_RE.test(m) },
  { hint: "Remove the credential", message: "contains a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, severity: "blocker" },
  { hint: "Remove the credential", message: "contains an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: "blocker", allow: (m) => PLACEHOLDER_RE.test(m) || /EXAMPLE/.test(m) },
  { hint: "Remove the credential", message: "contains a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, severity: "blocker" },
  { hint: "Remove the credential", message: "contains a Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g, severity: "blocker" },
  { hint: "Remove the credential", message: "contains a JWT", re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,2048}/g, severity: "blocker" },
  { hint: "Remove the private key", message: "contains a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, severity: "blocker" },
  { hint: "Remove the credential", message: "assigns a secret value", re: /(?<![?&\w])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)["']?\s*[:=]\s*["']?[^\s"'<>,;&]{8,}/gi, severity: "blocker", allow: (m) => !secretAssignment(m) },
  // URLs that carry credentials.
  { hint: "Remove the credentials from the URL", message: "URL contains a username and password", re: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g, severity: "blocker", allow: placeholderUrlCredentials },
  {
    hint: "Remove the credential from the URL",
    message: "URL contains a token or key parameter",
    re: /[?&](?:key|api_key|apikey|token|access_token|id_token|refresh_token|client_secret|secret|password|auth|sig|signature)=[^&\s#<>"'\]]{15,}[^&\s#<>"'\]!).,;]/gi,
    severity: "blocker",
    // `?key=marketing-automation-tools` is a slug, not a credential.
    allow: (m) => PLACEHOLDER_RE.test(m) || (/^[?&]key=/i.test(m) && KEBAB_VALUE_RE.test(m.slice(m.indexOf("=") + 1))),
  },
  // Internal infrastructure.
  { hint: "Remove the internal address", message: "contains a private IP address", re: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.(?:\d{1,3}\.){2}\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g, severity: "warning" },
  { hint: "Remove the internal hostname", message: "contains an internal hostname", re: /\b(?:localhost\b|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|local|corp|lan|localdomain)\b)/gi, severity: "warning" },
  // Personal data: a public contact can be legitimate, so these only warn.
  {
    hint: "Check this contact detail is meant to be public",
    message: "contains an email address",
    re: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    severity: "warning",
    allow: (m, input) => {
      const host = siteHost(input.siteUrl);
      return EXAMPLE_HOST_RE.test(m) || (ROLE_RE.test(m) && host !== "" && m.toLowerCase().endsWith(`@${host}`));
    },
  },
  {
    hint: "Check this contact detail is meant to be public",
    message: "contains a phone number",
    re: /(?<![\w+])\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?\b/g,
    severity: "warning",
    // Fictional +1 555 numbers, and anything outside 8-15 digits (E.164).
    allow: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length < 8 || digits.length > 15 || /^1\D*(?:\d{3}\D*)?555/.test(m.slice(1));
    },
  },
];

/**
 * Secrets and private data in the title, description or markdown (code blocks included), reported as `leaks`
 * (secrets, keys, credentialed URLs: blockers) and `leaks-warnings` (emails, phone numbers, private IPs and internal hosts,
 * which setup guides show on purpose, as in `localhost:5678`).
 * Excerpts are masked to 4 characters.
 */
export function leaksGate(input: GateInput): GateResult[] {
  const text = `${input.title}\n${input.description}\n${input.markdown}`;
  const seen = new Set<string>();
  const hits = (severity: "blocker" | "warning"): GateIssue[] =>
    RULES.filter((r) => r.severity === severity).flatMap((r) =>
      [...text.matchAll(r.re)].flatMap((m) => {
        if (r.allow?.(m[0], input) || seen.has(m[0])) return [];
        seen.add(m[0]);
        return [{ excerpt: mask(m[0]), hint: r.hint, message: r.message }];
      })
    );
  return [gateResult("leaks", hits("blocker")), gateResult("leaks-warnings", hits("warning"), "warning")];
}
