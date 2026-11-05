import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Play, Settings2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { BywordCard, SectionHeader } from "@/components/layout/BywordSurface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSites } from "@/hooks/useSites";
import { api } from "@/lib/api";
import { aiVisibilityKey, useAiVisibility, type AiVisibilityState, type VisibilityCheck, type VisibilitySettings } from "@/lib/ai-visibility";

const pct = (share: number) => `${Math.round(share * 100)}%`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const UNAVAILABLE = {
  no_openrouter_key: "Add an OpenRouter API key in Control → Integrations to check whether AI answers cite this site.",
  custom_gateway: "This check is not available with a self-hosted AI gateway yet.",
};

function Sparkline({ trend }: { trend: AiVisibilityState["summary"]["trend"] }) {
  if (trend.length < 2) return null;
  const pts = trend.map((t, i) => `${(i / (trend.length - 1)) * 96 + 2},${22 - t.share * 20}`).join(" ");
  return <svg role="img" aria-label="Share cited by week" viewBox="0 0 100 24" className="h-6 w-24 text-byword-blue"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}

const dot = (c: VisibilityCheck) => c.status !== "ok" ? "bg-status-error" : c.cited ? "bg-status-success" : "bg-muted-foreground/40";
const dotLabel = (c: VisibilityCheck) => c.status !== "ok" ? "failed" : c.cited ? "cited" : "not cited";

function QuestionRow({ question, checks }: { question: string; checks: VisibilityCheck[] }) {
  const [open, setOpen] = useState(false);
  return <div className="px-5 py-2.5">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{question}</span>
      <span className="flex shrink-0 gap-1">{checks.map((c) => <span key={c.engine} title={`${c.engineLabel}: ${dotLabel(c)}`} aria-label={`${c.engineLabel}: ${dotLabel(c)}`} className={`h-2 w-2 rounded-full ${dot(c)}`} />)}</span>
    </button>
    {open && <div className="mt-2 space-y-3 pl-6">{checks.map((c) => <div key={c.engine} className="space-y-1 text-xs">
      <p className="font-medium">{c.engineLabel} · {dotLabel(c)}</p>
      {c.status !== "ok" && c.error && <p className="text-status-error">{c.error}</p>}
      {c.citedUrls.length > 0 && <p className="break-all text-muted-foreground">Site pages: {c.citedUrls.join(", ")}</p>}
      {c.otherHosts.length > 0 && <p className="text-muted-foreground">Other sources: {c.otherHosts.join(", ")}</p>}
      {c.answer && <details><summary className="cursor-pointer text-muted-foreground">Answer</summary><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.answer}</p></details>}
    </div>)}</div>}
  </div>;
}

function GapRow({ siteId, gap }: { siteId: string; gap: AiVisibilityState["summary"]["gaps"][number] }) {
  const add = useMutation({
    mutationFn: () => api.post("/ai-visibility/gap-idea", { siteId, question: gap.question }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not add the idea"),
  });
  return <div className="flex items-center justify-between gap-3 px-5 py-2.5">
    <div className="min-w-0"><p className="text-sm">{gap.question}</p><p className="type-meta mt-0.5">{[...gap.competitorHosts, ...gap.otherHosts].slice(0, 4).join(", ")}{gap.twoWeeks ? " · 2 weeks running" : ""}</p></div>
    {add.isSuccess ? <Link to="/ideas" className="shrink-0 text-xs text-byword-blue hover:underline">Added · open Ideas</Link>
      : <Button type="button" size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate()}>Add as idea</Button>}
  </div>;
}

function SettingsDialog({ siteId, settings, open, onOpenChange }: { siteId: string; settings: VisibilitySettings; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(settings.questions.join("\n"));
  const [engines, setEngines] = useState(settings.engines);
  const [weekday, setWeekday] = useState(settings.weekday);
  const [cap, setCap] = useState(String(settings.monthlyCapUsd));
  const [terms, setTerms] = useState(settings.brandTerms.join(", "));
  const [enabled, setEnabled] = useState(settings.enabled);
  const [errors, setErrors] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const lines = () => text.split("\n").map((l) => l.trim()).filter(Boolean);

  const models = useQuery({ queryKey: ["ai-visibility-models"], queryFn: () => api.get<{ models: { id: string; label: string; searchPrice: number }[] }>("/ai-visibility/models"), enabled: open });
  const modelList = [...(models.data?.models ?? [])];
  for (const id of engines) if (!modelList.some((m) => m.id === id)) modelList.push({ id, label: id, searchPrice: 0 });
  const [allModels, setAllModels] = useState(false);
  // The chosen engines, then the two newest models per provider (the list arrives newest first); "Show all" lists the rest.
  const perProvider = new Map<string, number>();
  const shortList = [...modelList.filter((m) => engines.includes(m.id)), ...modelList.filter((m) => {
    if (engines.includes(m.id)) return false;
    const p = m.id.split("/")[0]!;
    perProvider.set(p, (perProvider.get(p) ?? 0) + 1);
    return perProvider.get(p)! <= 2;
  })];
  const shownModels = allModels ? modelList : shortList;

  const suggest = useMutation({
    mutationFn: () => api.post<{ questions: string[] }>("/ai-visibility/suggest", { siteId }),
    onSuccess: ({ questions }) => { setSuggested(questions); setPicked(new Set(questions)); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not suggest questions"),
  });
  const save = useMutation({
    mutationFn: () => {
      const questions = lines();
      setErrors([]);
      return api.put("/ai-visibility/settings", { siteId, settings: { enabled, questions, engines, weekday, monthlyCapUsd: Number(cap) || 0, brandTerms: terms.split(",").map((t) => t.trim()).filter(Boolean) } });
    },
    onSuccess: () => { toast.success("Settings saved"); qc.invalidateQueries({ queryKey: aiVisibilityKey(siteId) }); onOpenChange(false); },
    onError: (e) => {
      const items = (e as { indexErrors?: { index: number; message: string }[] }).indexErrors ?? [];
      if (items.length) { const q = lines(); setErrors(items.map((i) => `${q[i.index] ?? `Question ${i.index + 1}`}: ${i.message}`)); }
      else toast.error(e instanceof Error ? e.message : "Could not save settings");
    },
  });

  const addPicked = () => {
    const have = new Set(lines());
    setText([...lines(), ...suggested.filter((q) => picked.has(q) && !have.has(q))].join("\n"));
    setSuggested([]);
  };
  const toggleEngine = (id: string, on: boolean) => setEngines(on ? [...engines, id] : engines.filter((e) => e !== id));

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>AI answer check</DialogTitle><DialogDescription>Questions a buyer might ask an AI assistant. One per line.</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between"><Label htmlFor="ai-questions">Questions</Label>
            <Button type="button" size="sm" variant="outline" disabled={suggest.isPending} onClick={() => suggest.mutate()}>{suggest.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}Suggest</Button></div>
          <Textarea id="ai-questions" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          {errors.length > 0 && <ul role="alert" className="space-y-0.5 text-xs text-status-error">{errors.map((m) => <li key={m}>{m}</li>)}</ul>}
        </div>
        {suggested.length > 0 && <div className="space-y-1.5 rounded-sm border border-byword-border p-3">
          {suggested.map((q) => <label key={q} className="flex items-start gap-2 text-sm"><Checkbox checked={picked.has(q)} onCheckedChange={(on) => setPicked(new Set(on ? [...picked, q] : [...picked].filter((p) => p !== q)))} className="mt-0.5" />{q}</label>)}
          <Button type="button" size="sm" onClick={addPicked}>Add checked</Button>
        </div>}
        <fieldset className="space-y-1.5"><legend className="text-sm font-medium">Engines</legend>
          {shownModels.map((m) => <label key={m.id} className="flex items-center gap-2 text-sm"><Checkbox checked={engines.includes(m.id)} onCheckedChange={(on) => toggleEngine(m.id, on === true)} />{m.label}<span className="type-meta">{m.id}</span></label>)}
          {modelList.length > shortList.length && <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setAllModels(!allModels)}>{allModels ? "Show fewer" : `Show all ${modelList.length} models`}</Button>}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Weekly check on</Label>
            <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}><SelectTrigger aria-label="Weekday"><SelectValue /></SelectTrigger>
              <SelectContent>{WEEKDAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="ai-cap">Monthly cap (USD)</Label><Input id="ai-cap" type="number" min={0} step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="ai-terms">Brand terms</Label><Input id="ai-terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Comma separated" /></div>
        <label className="flex items-center justify-between text-sm font-medium">Run weekly<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Run weekly" /></label>
      </div>
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" disabled={save.isPending || !engines.length} onClick={() => save.mutate()}>Save</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function AiVisibilityPanel() {
  const siteId = useSites().activeSite?.id;
  const qc = useQueryClient();
  const { data } = useAiVisibility(siteId);
  const [editing, setEditing] = useState(false);
  const run = useMutation({
    mutationFn: () => api.post<{ started: boolean; message?: string }>("/ai-visibility/run", { siteId }),
    onSuccess: (res) => { toast.success(res.started ? "Check started" : res.message ?? "Nothing to check"); qc.invalidateQueries({ queryKey: aiVisibilityKey(siteId) }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not start the check"),
  });
  if (!siteId || !data) return null;

  const { settings, summary, running } = data;
  const { latest } = summary;
  const byQuestion = new Map<string, VisibilityCheck[]>();
  for (const c of summary.checks) byQuestion.set(c.question, [...(byQuestion.get(c.question) ?? []), c]);

  let body;
  if (!data.available) {
    body = <p className="p-5 text-sm text-muted-foreground">{UNAVAILABLE[data.reason ?? "no_openrouter_key"]}</p>;
  } else if (!settings.questions.length) {
    body = <div className="space-y-3 p-5 text-sm text-muted-foreground"><p>Ask AI assistants the questions your buyers ask, once a week, and see whether they cite your site or a competitor.</p><Button type="button" size="sm" onClick={() => setEditing(true)}>Add questions</Button></div>;
  } else {
    body = <>
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex flex-wrap items-center gap-5">
          {summary.week ? <div><p className="text-3xl font-semibold leading-none">{pct(latest.share)}</p><p className="type-meta mt-1.5">{latest.citedQuestions} of {latest.answered} questions cited · mentioned in {pct(latest.mentionedShare)}</p></div>
            : <p className="text-sm text-muted-foreground">No check has run yet.</p>}
          <Sparkline trend={summary.trend} />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={running || run.isPending} onClick={() => run.mutate()}>{running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}{running ? "Running" : "Run now"}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}><Settings2 className="mr-1.5 h-4 w-4" />Settings</Button>
        </div>
      </div>
      {latest.engines.length > 0 && <div className="border-t border-byword-border px-5 py-3"><table className="w-full text-sm"><thead><tr className="type-kicker text-left"><th className="py-1 font-medium">Engine</th><th className="py-1 font-medium">Cited</th><th className="py-1 text-right font-medium">Share</th></tr></thead>
        <tbody>{latest.engines.map((e) => <tr key={e.engine}><td className="py-1">{e.label}</td><td className="py-1">{e.cited} of {e.asked}</td><td className="py-1 text-right">{pct(e.share)}</td></tr>)}</tbody></table></div>}
      {summary.topCompetitors.length > 0 && <div className="flex flex-wrap items-center gap-1.5 border-t border-byword-border px-5 py-3"><span className="type-kicker mr-1">Cited instead</span>{summary.topCompetitors.map((c) => <Badge key={c.host} variant={c.flagged ? "default" : "outline"} title={c.flagged ? "Listed competitor" : undefined}>{c.host} · {c.count}</Badge>)}</div>}
      {summary.gaps.length > 0 && <div className="border-t border-byword-border"><p className="type-kicker px-5 pt-3">Gaps</p><div className="divide-y divide-byword-border">{summary.gaps.map((g) => <GapRow key={g.question} siteId={siteId} gap={g} />)}</div></div>}
      {byQuestion.size > 0 && <div className="border-t border-byword-border"><p className="type-kicker px-5 pt-3">Questions</p><div className="divide-y divide-byword-border">{[...byQuestion].map(([q, checks]) => <QuestionRow key={q} question={q} checks={checks} />)}</div></div>}
      <p className="type-meta border-t border-byword-border px-5 py-2.5">Cost this month ${summary.costThisMonth.toFixed(2)} of ${settings.monthlyCapUsd.toFixed(2)}{summary.week ? ` · week of ${summary.week}` : ""}</p>
    </>;
  }

  return <BywordCard>
    <SectionHeader icon={Sparkles} title="Cited in AI answers" description="Whether AI assistants cite this site when asked your questions." />
    {body}
    {editing && <SettingsDialog siteId={siteId} settings={settings} open onOpenChange={setEditing} />}
  </BywordCard>;
}
