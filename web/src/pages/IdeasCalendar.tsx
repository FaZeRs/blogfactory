import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { BywordCard, BywordPageShell } from "@/components/layout/BywordSurface";
import { RescheduleDialog } from "@/components/ideas/IdeaCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSites } from "@/hooks/useSites";
import { ideasKey, type CalendarSlot } from "@/lib/ideas";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function IdeasCalendar() {
  const siteId = useSites().activeSite?.id;
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [resched, setResched] = useState<{ id: string; title: string } | null>(null);
  const from = ymd(month);
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const { data, error } = useQuery({
    queryKey: ideasKey(siteId, "calendar", from),
    queryFn: () => api.get<{ timezone: string; slots: CalendarSlot[] }>(`/ideas/calendar?siteId=${siteId}&from=${from}&to=${ymd(next)}`),
    enabled: Boolean(siteId),
  });
  const byDate = new Map<string, CalendarSlot[]>();
  data?.slots.forEach((s) => byDate.set(s.localDate, [...(byDate.get(s.localDate) ?? []), s]));
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(month.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return <BywordPageShell className="max-w-7xl">
    <PageHeader title="Calendar" description={`Publishing slots${data ? ` (${data.timezone})` : ""}. Change the cadence in Settings.`}>
      <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></Button>
      <span className="min-w-32 text-center text-sm font-semibold" aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
      <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></Button>
    </PageHeader>
    {error && <p className="mb-3 text-sm text-destructive">Could not load the calendar.</p>}
    <BywordCard className="overflow-x-auto"><div className="min-w-[720px]">
      <div className="grid grid-cols-7 border-b border-byword-border text-center text-[11px] font-semibold text-muted-foreground">{WEEKDAYS.map((w) => <div key={w} className="py-1.5">{w}</div>)}</div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const slots = day ? byDate.get(`${from.slice(0, 8)}${pad(day)}`) ?? [] : [];
          return <div key={i} data-testid={day ? "day" : undefined} className="min-h-24 border-b border-r border-byword-border p-1.5 text-xs">
            {day && <div className="mb-1 text-muted-foreground">{day}</div>}
            {slots.map((s) => <div key={s.at} className="mb-1">
              {s.post ? <Link className="block truncate rounded-sm bg-byword-blue-soft px-1.5 py-1 text-byword-blue" to={`/library/posts/${s.post.id}/edit`}>{s.post.title}</Link>
                : s.idea ? (s.idea.status === "in_progress" || s.idea.jobId
                  ? <Link className="block truncate rounded-sm border border-byword-border px-1.5 py-1" to="/runs">{s.idea.title}</Link>
                  : <button type="button" className="block w-full truncate rounded-sm border border-byword-border px-1.5 py-1 text-left hover:bg-card" onClick={() => setResched({ id: s.idea!.id, title: s.idea!.title })} aria-label={`Reschedule ${s.idea.title}`}>{s.idea.title}</button>)
                : s.isCadenceSlot ? <span className="block rounded-sm border border-dashed border-byword-border px-1.5 py-1 text-muted-foreground">Open slot</span> : null}
            </div>)}
          </div>;
        })}
      </div>
    </div></BywordCard>
    <RescheduleDialog idea={resched} onClose={() => setResched(null)} />
  </BywordPageShell>;
}
