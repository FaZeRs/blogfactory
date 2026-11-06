import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { scopeLabel, type LearningSettings, type RulesByStatus, type StyleRule } from "@/lib/learning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const RULE_MAX = 200;
// How long "Suggest rules" keeps looking for its proposals: the model call runs in the background worker.
const SUGGEST_WATCH_MS = 3 * 60_000;

function EvalLine({ rule }: { rule: StyleRule }) {
  const e = rule.eval;
  if (!e) return null;
  if (e.status === "running") return <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />Testing against golden briefs…</p>;
  if (e.status === "failed") return <p className="text-xs text-destructive">Test failed: {e.error}</p>;
  return (
    <p className="text-xs text-muted-foreground" data-testid="eval-result">
      Eval: wins {e.wins}, losses {e.losses}, ties {e.ties} of {e.briefs} briefs · win rate {Math.round(e.winRate * 100)}% · mean score change {e.meanDelta > 0 ? "+" : ""}{e.meanDelta.toFixed(2)}. Advisory only.
    </p>
  );
}

function Proposal({ rule, onChanged }: { rule: StyleRule; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.rule);
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(`/learning/rules/${rule.id}/${path}`, body ?? {}),
    onSuccess: () => { setEditing(false); onChanged(); },
    onError: fail,
  });
  const retire = rule.op === "retire";
  const running = rule.eval?.status === "running";
  return (
    <li className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{scopeLabel(rule.scope)}</Badge>
        {retire && <Badge variant="secondary">Retire</Badge>}
      </div>
      {editing ? (
        <div className="space-y-1">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={RULE_MAX} rows={2} aria-label="Rule text" />
          <p className="text-xs text-muted-foreground">{text.trim().length}/{RULE_MAX}</p>
        </div>
      ) : (
        <p className="text-sm font-medium">{retire ? `Stop applying: ${rule.rule}` : rule.rule}</p>
      )}
      {rule.rationale && <p className="text-sm text-muted-foreground">{rule.rationale}</p>}
      {rule.evidence.length > 0 && (
        <ul className="space-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground" aria-label="Evidence">
          {rule.evidence.map((e) => (
            <li key={e.signalId}><span className="font-medium text-foreground">{e.kind === "comment" ? "Comment" : "Edit"}:</span> {e.excerpt}</li>
          ))}
        </ul>
      )}
      <EvalLine rule={rule} />
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={act.isPending || !text.trim() || text.trim().length > RULE_MAX} onClick={() => act.mutate({ path: "approve", body: { rule: text } })}>Save and approve</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(rule.rule); }}>Cancel</Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ path: "approve" })}>Approve</Button>
            {!retire && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => setEditing(true)}>Edit and approve</Button>}
            <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ path: "reject" })}>Reject</Button>
            {!retire && rule.scope === "draft" && (
              <Button size="sm" variant="secondary" disabled={act.isPending || running} onClick={() => act.mutate({ path: "eval" })}>Test with evals</Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function LearnedRulesTab({ siteId }: { siteId: string | null }) {
  const queryClient = useQueryClient();
  const [watching, setWatching] = useState(false);
  const rulesKey = ["learning", "rules", siteId];
  const settingsKey = ["learning", "settings", siteId];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["learning"] });
  const rules = useQuery({
    queryKey: rulesKey,
    queryFn: () => api.get<RulesByStatus>(`/learning/rules?siteId=${siteId}`),
    enabled: !!siteId,
    refetchInterval: (q) => (watching || q.state.data?.proposed.some((r) => r.eval?.status === "running") ? 5000 : false),
  });
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => api.get<LearningSettings>(`/learning/settings?siteId=${siteId}`), enabled: !!siteId });
  useEffect(() => {
    if (!watching) return;
    const t = setTimeout(() => setWatching(false), SUGGEST_WATCH_MS);
    return () => clearTimeout(t);
  }, [watching]);
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put(`/learning/settings?siteId=${siteId}`, { enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const suggest = useMutation({
    mutationFn: () => api.post(`/learning/distill?siteId=${siteId}`, {}),
    onSuccess: () => { setWatching(true); toast.success("Looking for patterns in your corrections"); },
    onError: fail,
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/learning/rules/${id}/retire`, {}),
    onSuccess: refresh,
    onError: fail,
  });

  if (!siteId) return <p className="text-sm text-muted-foreground">Choose a site to see its learned rules.</p>;
  if (rules.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (rules.isError || !rules.data) return <p className="text-sm text-destructive">The rules could not be loaded.</p>;
  const data = rules.data;
  const enabled = settings.data?.enabled ?? false;
  const closed = [...data.retired.map((r) => ({ r, label: "Retired" })), ...data.rejected.map((r) => ({ r, label: "Rejected" }))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-start gap-3">
          <Switch id="learning-enabled" checked={enabled} disabled={toggle.isPending || settings.isLoading} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Learn from my edits" />
          <div>
            <label htmlFor="learning-enabled" className="text-sm font-medium">Learn from my edits</label>
            <p className="text-xs text-muted-foreground">
              {enabled ? "Every Sunday, repeated corrections become proposed rules." : "Off: no weekly suggestions."} {settings.data ? `${settings.data.signals} corrections in the last 28 days.` : ""} Nothing applies until you approve it.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => suggest.mutate()} disabled={suggest.isPending || watching}>
          {suggest.isPending || watching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
          Suggest rules
        </Button>
      </div>

      <section className="space-y-3">
        <h3 className="type-panel-title">Proposed</h3>
        {data.proposed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No proposals. Edit a draft or a translation, or revise one with comments, then suggest rules.</p>
        ) : (
          <ul className="space-y-3">{data.proposed.map((r) => <Proposal key={r.id} rule={r} onChanged={refresh} />)}</ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="type-panel-title">Approved</h3>
        {data.approved.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. Approved rules are added to the writing prompts.</p>
        ) : (
          <ul className="space-y-2">
            {data.approved.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.rule}</p>
                  <p className="text-xs text-muted-foreground">{scopeLabel(r.scope)}</p>
                </div>
                <Button size="sm" variant="outline" disabled={retire.isPending} onClick={() => retire.mutate(r.id)}>Retire</Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <details className="rounded-md border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium">Retired and rejected ({closed.length})</summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {closed.map(({ r, label }) => <li key={r.id}>{label}: {r.rule} <span className="text-xs">({scopeLabel(r.scope)})</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
