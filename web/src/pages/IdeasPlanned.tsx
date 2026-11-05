import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { BywordCard, BywordPageShell } from "@/components/layout/BywordSurface";
import { EmptyState } from "@/components/patterns/EmptyState";
import { RescheduleDialog } from "@/components/ideas/IdeaCard";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { api } from "@/lib/api";
import { useSites } from "@/hooks/useSites";
import { STATUS_BADGE, formatSlot, ideasKey, type Idea } from "@/lib/ideas";

export default function IdeasPlanned() {
  const siteId = useSites().activeSite?.id;
  const [resched, setResched] = useState<Idea | null>(null);
  const { data, error, refetch } = useQuery({
    queryKey: ideasKey(siteId, "planned"),
    queryFn: () => api.get<{ items: Idea[] }>(`/ideas?siteId=${siteId}&status=scheduled,in_progress,drafted&sort=scheduled`),
    enabled: Boolean(siteId),
  });
  return <BywordPageShell className="max-w-7xl">
    <PageHeader title="Planned" description="Approved ideas, what is being written and what became drafts." />
    {error && <BywordCard><EmptyState tone="error" title="Could not load planned ideas" primaryAction={{ label: "Retry", onClick: () => refetch() }} /></BywordCard>}
    {data && data.items.length === 0 && <BywordCard><EmptyState title="Nothing planned" description="Approve an idea in the Inbox to schedule it." /></BywordCard>}
    {data && data.items.length > 0 && <BywordCard><ul className="divide-y divide-byword-border">
      {data.items.map((i) => { const b = STATUS_BADGE[i.status]; return <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
        <StatusBadge status={b.status} label={b.label} />
        <span className="min-w-0 flex-1 font-medium">{i.title}{i.error && <span className="block text-xs text-destructive">{i.error}</span>}</span>
        <span className="text-xs text-muted-foreground">{i.scheduledFor ? formatSlot(i.scheduledFor) : "Not scheduled"} · {i.mode}</span>
        {i.postId && <Link className="text-xs underline" to={`/library/posts/${i.postId}/edit`}>Open draft</Link>}
        {i.status === "in_progress" && <Link className="text-xs underline" to="/runs">Runs</Link>}
        {i.status === "scheduled" && <Button size="sm" variant="outline" onClick={() => setResched(i)}>Reschedule</Button>}
      </li>; })}
    </ul></BywordCard>}
    <RescheduleDialog idea={resched} onClose={() => setResched(null)} />
  </BywordPageShell>;
}
