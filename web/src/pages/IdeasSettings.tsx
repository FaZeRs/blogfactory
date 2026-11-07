import { useEffect, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { BywordCard, BywordPageShell } from "@/components/layout/BywordSurface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Globe2, Link2, X } from "lucide-react";
import { InputAffordance } from "@/components/ui/input-affordance";
import { TagInput } from "@/components/ui/tag-input";
import { api } from "@/lib/api";
import { bareDomain, normalizeHttpUrl, stripHttpProtocol, validateSourceUrl } from "@/lib/url-validation";
import { useSites } from "@/hooks/useSites";
import { FACTORS, ideasKey, type IdeaSettings, type IdeaSources } from "@/lib/ideas";

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

const MAX_FEEDS = 20;
const MAX_PAGES = 10;
const MAX_HN_QUERIES = 10;
const MAX_SUBREDDITS = 10;

/** One http(s) URL at a time (a page also takes an optional link pattern); the server drops anything that is not a public URL. */
function SourceUrlField({ id, items, max, withPattern, onChange }: {
  id: string; items: { url: string; pattern?: string }[]; max: number; withPattern?: boolean; onChange: (v: { url: string; pattern?: string }[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pattern, setPattern] = useState("");
  const url = draft.trim() && validateSourceUrl(draft).valid ? normalizeHttpUrl(draft) : null;
  const full = items.length >= max;
  const add = () => {
    if (!url) return;
    if (!items.some((i) => i.url === url) && !full) onChange([...items, pattern.trim() ? { url, pattern: pattern.trim() } : { url }]);
    setDraft(""); setPattern("");
  };
  const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <div className="min-w-56 flex-1"><InputAffordance id={id} type="text" inputMode="url" icon={Link2} value={draft} placeholder={withPattern ? "https://example.com/blog" : "https://example.com/feed.xml"}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onEnter} aria-invalid={Boolean(draft.trim() && !url)}
        onClear={() => setDraft("")} clearLabel="Clear URL" disabled={full} /></div>
      {withPattern && <Input aria-label="Link pattern" className="w-44" value={pattern} maxLength={100} placeholder="/blog/ (optional)" onChange={(e) => setPattern(e.target.value)} onKeyDown={onEnter} disabled={full} />}
      <Button type="button" variant="outline" onClick={add} disabled={!url || full}>Add</Button>
    </div>
    {draft.trim() && !url && <p className="text-xs text-destructive">Enter a public http(s) URL.</p>}
    {items.length > 0 && <ul className="space-y-1">{items.map((i) => <li key={i.url} className="flex items-center gap-2 text-xs">
      <span className="min-w-0 truncate">{i.url}</span>{i.pattern && <span className="shrink-0 rounded-sm border border-byword-border px-1.5 text-muted-foreground">contains {i.pattern}</span>}
      <button type="button" className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={`Remove ${i.url}`} onClick={() => onChange(items.filter((x) => x.url !== i.url))}><X className="h-3 w-3" /></button></li>)}</ul>}
  </div>;
}

export function IdeaSourcesCard({ value, onChange }: { value: IdeaSources; onChange: (v: IdeaSources) => void }) {
  const set = (p: Partial<IdeaSources>) => onChange({ ...value, ...p });
  return <BywordCard className="space-y-3 p-4">
    <h2 className="type-panel-title">Idea sources</h2>
    <p className="text-xs text-muted-foreground">Extra places discovery reads for ideas. Nothing here writes articles on its own.</p>
    <div><Label htmlFor="src-feeds">Feeds</Label>
      <SourceUrlField id="src-feeds" max={MAX_FEEDS} items={value.feeds.map((url) => ({ url }))} onChange={(v) => set({ feeds: v.map((i) => i.url) })} /></div>
    <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
      <div><Label htmlFor="src-hn">Hacker News searches</Label><TagInput id="src-hn" value={value.hn.queries} maxItems={MAX_HN_QUERIES} placeholder="Add a search" onChange={(v) => set({ hn: { ...value.hn, queries: v } })} /></div>
      <div><Label htmlFor="src-hn-points">Minimum points</Label><Input id="src-hn-points" type="number" min={0} max={1000} value={value.hn.minPoints} onChange={(e) => set({ hn: { ...value.hn, minPoints: num(e.target.value) } })} /></div>
    </div>
    <div><Label htmlFor="src-reddit">Subreddits</Label><TagInput id="src-reddit" value={value.subreddits} maxItems={MAX_SUBREDDITS} placeholder="webdev (without r/)" onChange={(v) => set({ subreddits: v })} /></div>
    <div><Label htmlFor="src-pages">Watched pages</Label>
      <p className="mb-1 text-[11px] text-muted-foreground">New links on a page become ideas. The first discovery only records what is there. The pattern is plain text the link must contain.</p>
      <SourceUrlField id="src-pages" withPattern max={MAX_PAGES} items={value.pages} onChange={(v) => set({ pages: v })} /></div>
  </BywordCard>;
}

export default function IdeasSettings() {
  const siteId = useSites().activeSite?.id;
  const qc = useQueryClient();
  // The form remembers which site it was loaded for; Save writes only to that site.
  const [loaded, setLoaded] = useState<{ siteId: string; settings: IdeaSettings } | null>(null);
  const { data } = useQuery({ queryKey: ideasKey(siteId, "settings"), queryFn: () => api.get<{ settings: IdeaSettings }>(`/settings/ideas?siteId=${siteId}`), enabled: Boolean(siteId) });
  // Reset while another site's settings load, so Save never writes one site's settings to another.
  useEffect(() => { setLoaded(data && siteId ? { siteId, settings: data.settings } : null); }, [data, siteId]);
  const s = loaded && loaded.siteId === siteId ? loaded.settings : null;
  const setS = (next: IdeaSettings) => setLoaded((l) => (l ? { ...l, settings: next } : l));
  const save = useMutation({
    mutationFn: () => api.put<{ settings: IdeaSettings }>(`/settings/ideas`, { siteId: loaded!.siteId, settings: loaded!.settings }),
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
      <IdeaSourcesCard value={s.sources} onChange={(sources) => set({ sources })} />
    </div>
  </BywordPageShell>;
}
