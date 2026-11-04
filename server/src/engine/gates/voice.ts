import type { EngineConfig } from "../config.js";
import { type GateIssue, type GateResult, gateResult } from "./types.js";

interface VoiceRule {
  id: string;
  message: string;
  re: RegExp;
  severity: "blocker" | "warning";
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\/]/g;
const escapeRe = (s: string) => s.replace(ESCAPE_RE, "\\$&");

/** The rules that stay in code; the phrase lists come from the config. */
export const FIXED_VOICE_RULES: readonly VoiceRule[] = [
  {
    id: "ai-powered",
    message: 'never say "AI-powered"',
    re: /\bai[-\s]powered\b/i,
    severity: "blocker",
  },
  {
    id: "hype",
    message: "hype vocabulary",
    re: /\b(revolutioni[sz]e\w*|revolutionary|game[-\s]?changer|cutting[-\s]edge|supercharge\w*|unlock the (?:full )?power|harness the power|fast[-\s]paced world|digital transformation)\b/i,
    severity: "blocker",
  },
  {
    id: "personification",
    message: "personifies the software",
    re: /\b(?:ai|digital) (?:teammate|employee|co-?worker|colleague)s?\b|\bnever sleeps\b/i,
    severity: "blocker",
  },
];

/** The fixed rules plus one rule per configured phrase: banned ones block, warned ones also match their endings. */
export function voiceRules(voice: EngineConfig["voice"]): VoiceRule[] {
  return [
    ...voice.bannedPhrases.map((p) => ({
      id: "banned-phrase",
      message: `uses the banned phrase ("${p}")`,
      re: new RegExp(escapeRe(p.normalize("NFC")), "i"),
      severity: "blocker" as const,
    })),
    ...FIXED_VOICE_RULES,
    ...voice.warnPhrases.map((p) => ({
      id: "avoid-phrase",
      message: `"${p}" is on the avoid list`,
      re: new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRe(p.normalize("NFC"))}\\p{L}*`,
        "iu"
      ),
      severity: "warning" as const,
    })),
  ];
}

/**
 * Brand-voice rules, reported as `voice` (blockers) and `voice-warnings`. The text is matched as NFC, so
 * a word typed with combining diacritics matches the same as one typed composed.
 */
export function voiceGate(
  text: string,
  voice: EngineConfig["voice"]
): GateResult[] {
  const nfc = text.normalize("NFC");
  const hits = (severity: "blocker" | "warning"): GateIssue[] =>
    voiceRules(voice)
      .filter((r) => r.severity === severity)
      .flatMap((r) => {
        const m = nfc.match(r.re);
        return m ? [{ excerpt: m[0], hint: r.id, message: r.message }] : [];
      });
  return [
    gateResult("voice", hits("blocker")),
    gateResult("voice-warnings", hits("warning"), "warning"),
  ];
}
