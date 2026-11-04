import { statusTone } from "@/components/runs/status-tone";
import type { EngineStageRun } from "@/lib/api";

const LABELS: Record<string, string> = {
  research: "Research",
  brief: "Brief",
  draft: "Draft",
  gates: "Checks",
  revise: "Revise",
  deliver: "Deliver",
};

function label(stage: string) {
  return LABELS[stage] ?? stage.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function duration(stage: EngineStageRun) {
  if (!stage.finishedAt) return "—";
  const seconds = Math.max(0, Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function StageTimeline({ stages }: { stages: EngineStageRun[] }) {
  return (
    <ol className="divide-y divide-byword-border rounded-md border border-border bg-card" aria-label="Stage timeline">
      {stages.map((stage) => {
        const tone = statusTone(stage.status === "succeeded" ? "completed" : stage.status);
        return (
          <li key={`${stage.stage}-${stage.attempt}`} className="px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">{label(stage.stage)}</span>
              <span className={`text-xs font-semibold capitalize ${tone.text}`}>{stage.status}</span>
              <span className="text-xs text-muted-foreground">Attempt {stage.attempt}</span>
              <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
                {stage.model && <span className="truncate">{stage.model}</span>}
                <span>${stage.costUsd.toFixed(2)}</span>
                <span>{duration(stage)}</span>
              </span>
            </div>
            {stage.status === "failed" && stage.error && (
              <p className="mt-1 text-xs text-status-error">{stage.error}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
