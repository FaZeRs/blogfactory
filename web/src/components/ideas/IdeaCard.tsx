import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { BywordCard } from "@/components/layout/BywordSurface";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/status-badge";
import { api } from "@/lib/api";
import { FACTORS, STATUS_BADGE, formatSlot, type Idea, type IdeaMode } from "@/lib/ideas";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export function ScoreBars({ idea }: { idea: Idea }) {
  const b = idea.scoreBreakdown;
  if (!b) return <p className="text-xs text-muted-foreground">Not scored yet.</p>;
  return <div className="space-y-1.5" aria-label="Score breakdown">
    {FACTORS.map(([key, label, hint]) => {
      const pct = Math.round(Math.max(0, Math.min(1, b[key])) * 100);
      return <div key={key} className="grid grid-cols-[minmax(0,1fr)_96px_32px] items-center gap-2 text-xs">
        <span><span className="font-semibold">{label}</span> <span className="text-muted-foreground">- {hint}</span></span>
        <div className="h-1.5 rounded-sm bg-muted" role="img" aria-label={`${label} ${pct} of 100`}><div className="h-full rounded-sm bg-byword-blue" style={{ width: `${pct}%` }} /></div>
        <span className="text-right tabular-nums">{pct}</span>
      </div>;
    })}
    {b.rationale && <p className="pt-1 text-xs text-muted-foreground">{b.rationale}</p>}
  </div>;
}

export function RescheduleDialog({ idea, onClose }: { idea: { id: string; title: string; scheduledFor?: string | null } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/ideas/${idea!.id}/reschedule`, { scheduledFor: date }),
    onSuccess: () => { toast.success("Rescheduled"); qc.invalidateQueries({ queryKey: ["ideas"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return <Dialog open={Boolean(idea)} onOpenChange={(o) => !o && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>Reschedule</DialogTitle><DialogDescription>{idea?.title}</DialogDescription></DialogHeader>
      <Label htmlFor="resched-date">New date</Label>
      <Input id="resched-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!date || m.isPending} onClick={() => m.mutate()}>Reschedule</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

type Dlg = null | "edit" | "approve" | "reject";

export function IdeaCard({ idea }: { idea: Idea }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [form, setForm] = useState({ title: idea.title, angle: idea.angle ?? "", primaryKeyword: idea.primaryKeyword ?? "", mode: idea.mode as IdeaMode });
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const done = () => { setDlg(null); qc.invalidateQueries({ queryKey: ["ideas"] }); };
  const fail = (e: unknown) => toast.error(errMsg(e));
  const edit = useMutation({ mutationFn: () => api.patch(`/ideas/${idea.id}`, form), onSuccess: () => { toast.success("Saved"); done(); }, onError: fail });
  const approve = useMutation({
    mutationFn: () => api.post<{ idea: Idea }>(`/ideas/${idea.id}/approve`, { ...(date ? { scheduledFor: date } : {}), ...form }),
    onSuccess: (r) => { toast.success(r.idea.scheduledFor ? `Scheduled for ${formatSlot(r.idea.scheduledFor)}` : "Approved"); done(); }, onError: fail,
  });
  const reject = useMutation({ mutationFn: () => api.post(`/ideas/${idea.id}/reject`, reason ? { reason } : {}), onSuccess: () => { toast.success("Rejected"); done(); }, onError: fail });
  const writeNow = useMutation({
    mutationFn: () => api.post<{ run: { estimateUsd: number } }>(`/ideas/${idea.id}/write-now`),
    onSuccess: (r) => { toast.success(`Writing started (about $${r.run.estimateUsd.toFixed(2)})`, { action: { label: "Open Runs", onClick: () => navigate("/runs") } }); done(); },
    onError: fail,
  });
  const b = idea.scoreBreakdown;
  const { whyNow, outline = [], informationGain = [], sources = [] } = idea.brief;
  const busy = approve.isPending || reject.isPending || writeNow.isPending;
  const badge = STATUS_BADGE[idea.status];
  return <BywordCard className="p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <StatusBadge status={badge.status} label={badge.label} />
          {idea.origin === "refresh" && <span className="rounded-sm border border-byword-border px-1.5 py-0.5 text-[11px] font-semibold">Refresh</span>}
          {idea.origin === "manual" && <span className="text-[11px] text-muted-foreground">Manual</span>}
        </div>
        <h3 className="type-panel-title">{idea.title}</h3>
        {idea.angle && <p className="type-body mt-1">{idea.angle}</p>}
      </div>
      <div className="shrink-0 text-right" aria-label={`Score ${idea.score ?? "not scored"}`}>
        <div className="text-2xl font-semibold tabular-nums">{idea.score == null ? "-" : Math.round(idea.score)}</div>
        <div className="text-[11px] text-muted-foreground">score</div>
      </div>
    </div>
    <div className="mt-3 grid gap-4 md:grid-cols-2">
      <div className="space-y-2 text-xs">
        {whyNow && <p><span className="font-semibold">Why now:</span> {whyNow}</p>}
        {idea.primaryKeyword && <p><span className="font-semibold">Keyword:</span> {idea.primaryKeyword}
          {b?.keyword && <span className="text-muted-foreground"> · volume {b.keyword.volume ?? "n/a"} · difficulty {b.keyword.difficulty ?? "n/a"} · {b.keyword.intent ?? idea.searchIntent ?? "intent n/a"}</span>}</p>}
        {/* A sitemap page matches by its URL (it has no post id), so it links out instead of to the editor. */}
        {b?.nearestPost && <p>Similar to: {/^https?:\/\//i.test(b.nearestPost.id)
          ? <a className="underline" href={b.nearestPost.id} target="_blank" rel="noreferrer">{b.nearestPost.title}</a>
          : <Link className="underline" to={`/library/posts/${b.nearestPost.id}/edit`}>{b.nearestPost.title}</Link>} ({Math.round(b.nearestPost.similarity * 100)}% match)</p>}
        {outline.length > 0 && <div><span className="font-semibold">Outline</span><ol className="ml-4 list-decimal">{outline.map((h) => <li key={h}>{h}</li>)}</ol></div>}
        {informationGain.length > 0 && <div><span className="font-semibold">Information gain</span><ul className="ml-4 list-disc">{informationGain.map((h) => <li key={h}>{h}</li>)}</ul></div>}
        {sources.length > 0 && <p><span className="font-semibold">Sources:</span> {sources.map((s, i) => <span key={s.url}>{i > 0 && ", "}<a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></span>)}</p>}
        {idea.error && <p className="text-destructive">Error: {idea.error}</p>}
      </div>
      <ScoreBars idea={idea} />
    </div>
    {idea.status === "new" && <div className="mt-4 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => setDlg("approve")} disabled={busy}>Approve</Button>
      <Button size="sm" variant="secondary" onClick={() => writeNow.mutate()} disabled={busy}>Write now</Button>
      <Button size="sm" variant="outline" onClick={() => setDlg("edit")} disabled={busy}>Edit</Button>
      <Button size="sm" variant="outline" onClick={() => setDlg("reject")} disabled={busy}>Reject</Button>
    </div>}
    <Dialog open={dlg === "edit" || dlg === "approve"} onOpenChange={(o) => !o && setDlg(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{dlg === "approve" ? "Approve idea" : "Edit idea"}</DialogTitle><DialogDescription>{dlg === "approve" ? "Pick a date, or leave it empty for the next free slot." : "Changes apply before writing."}</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div><Label htmlFor={`t-${idea.id}`}>Title</Label><Input id={`t-${idea.id}`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div><Label htmlFor={`a-${idea.id}`}>Angle</Label><Textarea id={`a-${idea.id}`} value={form.angle} onChange={(e) => setForm({ ...form, angle: e.target.value })} /></div>
          <div><Label htmlFor={`k-${idea.id}`}>Primary keyword</Label><Input id={`k-${idea.id}`} value={form.primaryKeyword} onChange={(e) => setForm({ ...form, primaryKeyword: e.target.value })} /></div>
          <div><Label>Mode</Label>
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as IdeaMode })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="normal">Normal</SelectItem><SelectItem value="deep">Deep</SelectItem></SelectContent>
            </Select></div>
          {dlg === "approve" && <div><Label htmlFor={`d-${idea.id}`}>Publish date (optional)</Label><Input id={`d-${idea.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />{!date && <p className="mt-1 text-xs text-muted-foreground">Next free slot</p>}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDlg(null)}>Cancel</Button>
          {dlg === "approve" ? <Button disabled={approve.isPending} onClick={() => approve.mutate()}>Approve</Button> : <Button disabled={edit.isPending || form.title.length < 5} onClick={() => edit.mutate()}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={dlg === "reject"} onOpenChange={(o) => !o && setDlg(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reject idea</DialogTitle><DialogDescription>The reason is saved with the idea.</DialogDescription></DialogHeader>
        <Label htmlFor={`r-${idea.id}`}>Reason (optional)</Label>
        <Textarea id={`r-${idea.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        <DialogFooter><Button variant="outline" onClick={() => setDlg(null)}>Cancel</Button><Button disabled={reject.isPending} onClick={() => reject.mutate()}>Reject</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </BywordCard>;
}
