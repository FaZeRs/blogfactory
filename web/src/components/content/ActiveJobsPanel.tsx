import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { TrackedJob } from "@/hooks/useJobTracker";
import { GenerationProgress } from "@/components/content/GenerationProgress";
import { EngineRunView } from "@/components/runs/EngineRunView";
import { Button } from "@/components/ui/button";
import { api, type EngineRunDetail } from "@/lib/api";
import { X } from "lucide-react";

/** Normal and deep runs show their real stages, live, instead of the one-shot progress bar. */
function EngineJobProgress({ jobId }: { jobId: string }) {
  const { data } = useQuery({
    queryKey: ["job-engine-live", jobId],
    queryFn: () => api.get<{ engine?: EngineRunDetail }>(`/jobs/${jobId}`),
    refetchInterval: (query) => (query.state.data?.engine?.state === "active" || !query.state.data ? 4000 : false),
  });
  if (!data?.engine) return null;
  return (
    <div className="space-y-2 rounded-md border border-byword-border bg-card p-3">
      <EngineRunView engine={data.engine} />
      <Link to={`/runs?search=${jobId.slice(0, 8)}`} className="inline-block text-xs text-byword-blue hover:underline">
        Open in Runs
      </Link>
    </div>
  );
}

interface ActiveJobsPanelProps {
  jobs: TrackedJob[];
  onDismiss: (trackId: string) => void;
}

export function ActiveJobsPanel({ jobs, onDismiss }: ActiveJobsPanelProps) {
  if (jobs.length === 0) return null;

  return (
    <div className="space-y-3">
      {jobs.length > 1 && (
        <p className="type-kicker">
          Active jobs ({jobs.length})
        </p>
      )}
      {jobs.map((job) => (
        <div key={job.id} className="relative">
          {(job.step === "complete" || job.step === "error") && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 h-6 w-6 z-10"
              onClick={() => onDismiss(job.id)}
              aria-label="Dismiss job"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          <div className="text-xs text-muted-foreground mb-1 px-1">
            {job.sourceLabel}
          </div>
          {job.engine && job.jobId ? (
            <EngineJobProgress jobId={job.jobId} />
          ) : job.engine && job.step === "error" ? (
            <p className="rounded-md border border-status-error/30 bg-status-error/5 px-3 py-2 text-sm text-status-error">{job.error}</p>
          ) : <GenerationProgress
            currentStep={job.step}
            sourceType={job.sourceType}
            error={job.error}
            draftProgress={job.draftProgress}
          />}
        </div>
      ))}
    </div>
  );
}
