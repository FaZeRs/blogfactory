import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { BywordCard, BywordPageShell } from "@/components/layout/BywordSurface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Globe2, X } from "lucide-react";
import { InputAffordance } from "@/components/ui/input-affordance";
import { TagInput } from "@/components/ui/tag-input";
import { api } from "@/lib/api";
import { bareDomain, stripHttpProtocol } from "@/lib/url-validation";
import { useSites } from "@/hooks/useSites";
import { FACTORS, ideasKey, type IdeaSettings } from "@/lib/ideas";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const num = (v: string) => (v === "" ? 0 : Number(v));

const MAX_COMPETITORS = 10;

/** One domain at a time, normalized to a bare domain before it joins the list. */
function CompetitorField({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const domain = bareDomain(draft);
  const add = () => {
    if (!domain) return;
    if (!value.includes(domain) && value.length < MAX_COMPETITORS) onChange([...value, domain]);
    setDraft("");
  };
  return <div className="space-y-2">
    <div className="flex gap-2">
      <InputAffordance id={id} type="text" inputMode="url" prefix="https://" icon={Globe2} value={draft} placeholder="rival.com"
        onChange={(e) => setDraft(stripHttpProtocol(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        aria-invalid={Boolean(draft.trim() && !domain)} help="A domain such as rival.com. Paths and www are dropped."
        onClear={() => setDraft("")} clearLabel="Clear domain" disabled={value.length >= MAX_COMPETITORS} />
      <Button type="button" variant="outline" onClick={add} disabled={!domain || value.length >= MAX_COMPETITORS}>Add</Button>
    </div>
    {draft.trim() && !domain && <p className="text-xs text-destructive">Enter a valid domain, for example rival.com.</p>}
    {value.length > 0 && <ul className="flex flex-wrap gap-1.5">{value.map((d) => <li key={d} className="inline-flex h-6 items-center gap-1 rounded-sm border border-byword-border px-2 text-xs">
      {d}<button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${d}`} onClick={() => onChange(value.filter((x) => x !== d))}><X className="h-3 w-3" /></button></li>)}</ul>}
  </div>;
}

export default function IdeasSettings() {
  const siteId = useSites().activeSite?.id;
  const qc = useQueryClient();
  const [s, setS] = useState<IdeaSettings | null>(null);
  const { data } = useQuery({ queryKey: ideasKey(siteId, "settings"), queryFn: () => api.get<{ settings: IdeaSettings }>(`/settings/ideas?siteId=${siteId}`), enabled: Boolean(siteId) });
  // Reset while another site's settings load, so Save never writes one site's settings to another.
  useEffect(() => { setS(data?.settings ?? null); }, [data]);
  const save = useMutation({
    mutationFn: () => api.put<{ settings: IdeaSettings }>(`/settings/ideas`, { siteId, settings: s }),
    onSuccess: () => { toast.success("Settings saved"); qc.invalidateQueries({ queryKey: ["ideas"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });
  if (!s) return <BywordPageShell className="max-w-7xl"><PageHeader title="Idea settings" /></BywordPageShell>;
  const set = (p: Partial<IdeaSettings>) => setS({ ...s, ...p });
  return <BywordPageShell className="max-w-4xl">
    <PageHeader title="Idea settings" description="Cadence, autopilot and how ideas are scored.">
      <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
    </PageHeader>
    <div className="space-y-4">
      <BywordCard className="space-y-3 p-4">
        <h2 className="type-panel-title">Cadence</h2>
        <div role="group" aria-label="Publishing weekdays" className="flex flex-wrap gap-2">
          {DAYS.map((d, i) => { const on = s.cadence.weekdays.includes(i); return <Button key={d} type="button" size="sm" variant={on ? "default" : "outline"} aria-pressed={on}
            onClick={() => set({ cadence: { ...s.cadence, weekdays: on ? s.cadence.weekdays.filter((x) => x !== i) : [...s.cadence.weekdays, i].sort() } })}>{d}</Button>; })}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div><Label htmlFor="cad-time">Time</Label><Input id="cad-time" type="time" value={s.cadence.time} onChange={(e) => set({ cadence: { ...s.cadence, time: e.target.value } })} /></div>
          <div><Label htmlFor="cad-tz">Timezone</Label><Input id="cad-tz" value={s.cadence.timezone} onChange={(e) => set({ cadence: { ...s.cadence, timezone: e.target.value } })} /></div>
          <div><Label htmlFor="lead">Lead days</Label><Input id="lead" type="number" min={0} value={s.leadDays} onChange={(e) => set({ leadDays: num(e.target.value) })} /></div>
          <div><Label>Default mode</Label>
            <Select value={s.defaultMode} onValueChange={(v) => set({ defaultMode: v as IdeaSettings["defaultMode"] })}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="normal">Normal</SelectItem><SelectItem value="deep">Deep</SelectItem></SelectContent></Select></div>
        </div>
      </BywordCard>
      <BywordCard className="space-y-3 p-4">
        <div className="flex items-center justify-between"><h2 className="type-panel-title">Autopilot</h2>
          <Switch aria-label="Autopilot" checked={s.autopilot.enabled} onCheckedChange={(v) => set({ autopilot: { ...s.autopilot, enabled: v } })} /></div>
        <p className="text-xs text-muted-foreground">Approves the best ideas for you. Drafts still wait for your review.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor="ap-n">Approve per week</Label><Input id="ap-n" type="number" min={0} value={s.autopilot.approvePerWeek} onChange={(e) => set({ autopilot: { ...s.autopilot, approvePerWeek: num(e.target.value) } })} /></div>
          <div><Label htmlFor="ap-s">Minimum score (0-100)</Label><Input id="ap-s" type="number" min={0} max={100} value={s.autopilot.minScore} onChange={(e) => set({ autopilot: { ...s.autopilot, minScore: num(e.target.value) } })} /></div>
        </div>
      </BywordCard>
      <BywordCard className="space-y-3 p-4">
        <div className="flex items-center justify-between"><h2 className="type-panel-title">Scoring weights</h2>
          <div className="flex items-center gap-2"><Label htmlFor="learn" className="text-xs">Learn from results</Label>
            <Switch id="learn" checked={s.learnWeights} onCheckedChange={(v) => set({ learnWeights: v })} /></div></div>
        <p className="text-xs text-muted-foreground">
          {s.learnWeights ? "Once a month, weights move up to 10% toward what earned search clicks (at least 5 published ideas)." : "Learning is off. Weights stay as you set them."}
          {" "}{s.weightsLearnedMonth ? `Last learned ${s.weightsLearnedMonth}.` : "Not learned yet."}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {FACTORS.map(([k, label, hint]) => <div key={k}><Label htmlFor={`w-${k}`}>{label}</Label><Input id={`w-${k}`} type="number" min={0} max={3} step={0.05} value={s.weights[k]} onChange={(e) => set({ weights: { ...s.weights, [k]: num(e.target.value) } })} /><p className="mt-1 text-[11px] text-muted-foreground">{hint}</p></div>)}
        </div>
        {s.weightHistory.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-[11px]">
          <caption className="sr-only">Weight learning history</caption>
          <thead className="text-muted-foreground"><tr><th className="py-1 pr-3 font-medium">Month</th><th className="pr-3 font-medium">Samples</th>{FACTORS.map(([k, label]) => <th key={k} className="pr-3 font-medium">{label}</th>)}</tr></thead>
          <tbody>{[...s.weightHistory].reverse().map((h) => <tr key={h.month} className="border-t"><td className="py-1 pr-3">{h.month}</td><td className="pr-3">{h.samples}</td>{FACTORS.map(([k]) => <td key={k} className="pr-3 tabular-nums">{h.weights[k].toFixed(2)}</td>)}</tr>)}</tbody>
        </table></div>}
      </BywordCard>
      <BywordCard className="space-y-3 p-4">
        <div><Label htmlFor="seeds">Seed topics</Label><TagInput id="seeds" value={s.seedTopics} onChange={(v) => set({ seedTopics: v })} placeholder="Add a topic" /></div>
        <div><Label htmlFor="comp">Competitor domains</Label><CompetitorField id="comp" value={s.competitors} onChange={(v) => set({ competitors: v })} /></div>
      </BywordCard>
    </div>
  </BywordPageShell>;
}
