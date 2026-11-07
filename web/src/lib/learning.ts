export type RuleStatus = "proposed" | "approved" | "rejected" | "retired";
export interface RuleEvidence { signalId: string; kind: "edit" | "comment"; locale: string | null; excerpt: string }
export type RuleEval =
  | { status: "running"; startedAt: string }
  | { status: "failed"; error: string; finishedAt: string }
  | { status: "done"; winRate: number; meanDelta: number; dims: Record<string, number>; wins: number; losses: number; ties: number; briefs: number; costUsd: number; finishedAt: string };
export interface StyleRule {
  id: string; scope: string; rule: string; rationale: string; op: "add" | "retire"; targetRuleId: string | null;
  status: RuleStatus; evidence: RuleEvidence[]; eval: RuleEval | null; createdAt: string; decidedAt: string | null;
}
export interface RulesByStatus { proposed: StyleRule[]; approved: StyleRule[]; retired: StyleRule[]; rejected: StyleRule[] }
export interface LearningSettings { enabled: boolean; lastDistillAt: string | null; signals: number }

/** `draft` reads as English drafts; `translation:lv` as the language's name when the browser knows it. */
export function scopeLabel(scope: string): string {
  if (scope === "draft") return "English drafts";
  const code = scope.replace(/^translation:/, "");
  let name = code;
  try { name = new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { /* keep the code */ }
  return `${name} translation`;
}
