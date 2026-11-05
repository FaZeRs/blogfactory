import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { BywordCard, BywordPageShell } from "@/components/layout/BywordSurface";
import { EmptyState } from "@/components/patterns/EmptyState";
import { IdeaCard } from "@/components/ideas/IdeaCard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useSites } from "@/hooks/useSites";
import { ideasKey, type Idea, type IdeaDiscovery } from "@/lib/ideas";

export default function Ideas() {
  const { activeSite } = useSites();
  const siteId = activeSite?.id;
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const ideas = useQuery({
    queryKey: ideasKey(siteId, "inbox"),
    queryFn: () => api.get<{ items: Idea[] }>(`/ideas?siteId=${siteId}&status=new&sort=score`),
    enabled: Boolean(siteId),
  });
  const discoveries = useQuery({
    queryKey: ideasKey(siteId, "discoveries"),
    queryFn: () => api.get<{ items: IdeaDiscovery[] }>(`/ideas/discoveries?siteId=${siteId}`),
    enabled: Boolean(siteId),
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.items[0]?.status ?? "") ? 3000 : false),
  });
  const last = discoveries.data?.items[0];
  const active = last?.status === "queued" || last?.status === "running";
  // Reload the inbox when a discovery finishes.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) qc.invalidateQueries({ queryKey: ideasKey(siteId, "inbox") });
    wasActive.current = active;
  }, [active, qc, siteId]);
  const discover = useMutation({
    mutationFn: () => api.post(`/ideas/discover`, { siteId }),
    onSuccess: () => { toast.success("Discovery started"); qc.invalidateQueries({ queryKey: ideasKey(siteId, "discoveries") }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not start discovery"),
  });
  const create = useMutation({
    mutationFn: () => api.post(`/ideas`, { siteId, title }),
    onSuccess: () => { setAdding(false); setTitle(""); qc.invalidateQueries({ queryKey: ["ideas"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not add idea"),
  });
  return <BywordPageShell className="max-w-7xl">
    <PageHeader title="Ideas" description="Scored topics worth writing, with the reasons shown. Approve to schedule, or write now.">
      <Button variant="outline" onClick={() => setAdding(true)}>Add idea</Button>
      <Button onClick={() => discover.mutate()} disabled={!siteId || active || discover.isPending}><Sparkles className="mr-2 h-4 w-4" />{active ? "Discovering..." : "Discover ideas"}</Button>
    </PageHeader>
    {last && <p className="mb-4 text-xs text-muted-foreground" role="status">
      Last discovery: {last.status}{last.status === "done" && ` · ${last.signalCount ?? 0} signals, ${last.ideaCount ?? 0} ideas`}{last.costUsd != null && ` · $${last.costUsd.toFixed(2)}`}{last.error && <span className="text-destructive"> · {last.error}</span>}
    </p>}
    {ideas.error && <BywordCard><EmptyState tone="error" title="Could not load ideas" description="Nothing was changed." primaryAction={{ label: "Retry", onClick: () => ideas.refetch() }} /></BywordCard>}
    {ideas.data && ideas.data.items.length === 0 && <BywordCard><EmptyState title="No new ideas" description="Run discovery to find topics from Search Console, news and your feeds." /></BywordCard>}
    <div className="space-y-4">{ideas.data?.items.map((i) => <IdeaCard key={i.id} idea={i} />)}</div>
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add idea</DialogTitle><DialogDescription>It is scored like discovered ideas.</DialogDescription></DialogHeader>
        <Label htmlFor="new-idea-title">Title (5-160 characters)</Label>
        <Input id="new-idea-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        <DialogFooter><Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={title.trim().length < 5 || create.isPending} onClick={() => create.mutate()}>Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </BywordPageShell>;
}
