import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, RotateCcw, Wand2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BywordCard, SectionHeader } from "@/components/layout/BywordSurface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface CoverVersion { id: string; path: string; url: string; source_kind: "ai" | "ai_edit" | "manual" | "stock" }
interface CoverState {
  cover: { path: string; url: string } | null;
  versions: CoverVersion[];
  pending: Array<{ id: string; status: "queued" | "processing"; kind: "generate" | "adjust" }>;
  presets: Array<{ id: string; label: string }>;
  default_preset: string;
  prompt_draft: string;
  prompt_drafts: Record<string, string>;
  image_model: string | null;
  can_edit: boolean;
  cost_per_image: number | null;
}

const KIND_LABEL = { ai: "Generated", ai_edit: "Adjusted", manual: "Uploaded", stock: "Stock" } as const;
const WAIT_MS = 90_000;
const money = (value: number) => `$${value.toFixed(2)}`;

/** Cover tools for the editor: versions, generate, adjust. Server-side cover changes flow back through ["post", postId]. */
export function CoverPanel({ postId, disabled }: { postId: string; disabled: boolean }) {
  const queryClient = useQueryClient();
  const key = ["post-covers", postId];
  const [timedOut, setTimedOut] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [modelMissing, setModelMissing] = useState(false);
  const hadPending = useRef(false);

  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<CoverState>(`/images/posts/${postId}/covers`),
    refetchInterval: (query) => (query.state.data?.pending.length && !timedOut ? 3000 : false),
  });
  const pendingCount = data?.pending.length ?? 0;

  // Seed the preset and prompt once the server defaults arrive.
  useEffect(() => {
    if (!data || preset !== null) return;
    setPreset(data.default_preset);
    setPrompt(data.prompt_drafts[data.default_preset] ?? data.prompt_draft);
  }, [data, preset]);

  const refreshPost = () => {
    queryClient.invalidateQueries({ queryKey: ["post", postId] });
    queryClient.invalidateQueries({ queryKey: ["post-preflight", postId] });
  };

  useEffect(() => {
    if (pendingCount > 0) {
      hadPending.current = true;
      const timer = setTimeout(() => {
        setTimedOut(true);
        toast.error("The cover is taking longer than expected. Check the Image Gallery for its status.");
      }, WAIT_MS);
      return () => clearTimeout(timer);
    }
    if (hadPending.current) {
      hadPending.current = false;
      refreshPost();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCount]);

  const onError = (error: unknown) => {
    if ((error as { code?: string }).code === "image_model_missing") setModelMissing(true);
    else toast.error(error instanceof Error ? error.message : "Cover request failed");
  };
  const queued = () => {
    setTimedOut(false);
    setModelMissing(false);
    queryClient.invalidateQueries({ queryKey: key });
  };
  const generate = useMutation({
    mutationFn: (count: 1 | 3) => api.post(`/images/posts/${postId}/cover`, { prompt, preset, count }),
    onSuccess: queued,
    onError,
  });
  const adjust = useMutation({
    mutationFn: () => api.post(`/images/posts/${postId}/cover/adjust`, { instruction: instruction.trim() }),
    onSuccess: () => { setInstruction(""); queued(); },
    onError,
  });
  const choose = useMutation({
    mutationFn: (assetId: string) => api.put(`/images/posts/${postId}/cover`, { asset_id: assetId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: key }); refreshPost(); },
    onError,
  });

  if (!data) return null;
  const busy = disabled || generate.isPending || adjust.isPending || choose.isPending;
  const cost = (n: number) => (data.cost_per_image == null ? "" : ` · ${money(data.cost_per_image * n)}`);
  const draft = (id: string) => data.prompt_drafts[id] ?? data.prompt_draft;
  const canAdjust = Boolean(data.cover) && data.can_edit;

  return (
    <div id="cover" className="scroll-mt-4"><BywordCard className="mb-6">
      <SectionHeader icon={ImagePlus} title="Cover" description="Generate, adjust or switch between cover versions." />
      <div className="space-y-4 p-4 sm:p-5">
        {disabled && <p className="text-xs text-muted-foreground">Save your changes to use cover tools.</p>}
        {data.cover ? (
          <img src={data.cover.url} alt="Current cover" className="aspect-video w-full max-w-xl rounded-sm border border-border object-cover" />
        ) : (
          <div className="flex aspect-video w-full max-w-xl items-center justify-center rounded-sm border border-dashed border-border text-sm text-muted-foreground">No cover yet</div>
        )}

        {(data.versions.length > 0 || pendingCount > 0) && (
          <div className="flex flex-wrap gap-2" aria-label="Cover versions">
            {data.pending.map((item) => (
              <div key={item.id} className="flex h-16 w-28 items-center justify-center rounded-sm border border-dashed border-border bg-muted/40" role="status" aria-label={item.status === "queued" ? "Queued" : "Generating"}>
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ))}
            {data.versions.map((version) => {
              const current = version.path === data.cover?.path;
              return (
                <button
                  key={version.id}
                  type="button"
                  disabled={busy || current}
                  onClick={() => choose.mutate(version.id)}
                  aria-pressed={current}
                  className={cn("w-28 rounded-sm border p-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", current ? "border-byword-blue" : "border-border hover:border-foreground/40")}
                >
                  <img src={version.url} alt="" className="h-16 w-full rounded-[2px] object-cover" />
                  <span className="mt-0.5 block px-1 text-[11px] text-muted-foreground">{KIND_LABEL[version.source_kind]}{current ? " · current" : ""}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <Select value={preset ?? undefined} onValueChange={(value) => { setPreset(value); setPrompt(draft(value)); }}>
            <SelectTrigger className="w-full sm:w-64" aria-label="Cover style"><SelectValue /></SelectTrigger>
            <SelectContent>{data.presets.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-24 resize-none" aria-label="Cover prompt" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => generate.mutate(1)} disabled={busy}>Generate 1{cost(1)}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => generate.mutate(3)} disabled={busy}>Generate 3{cost(3)}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPrompt(draft(preset ?? data.default_preset))} disabled={busy}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset</Button>
          </div>
        </div>

        {canAdjust && (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); adjust.mutate(); }}>
            <Input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Adjust this cover, e.g. make the background darker" maxLength={500} aria-label="Adjust instruction" />
            <Button type="submit" size="sm" variant="outline" disabled={busy || instruction.trim().length < 3}><Wand2 className="mr-1.5 h-3.5 w-3.5" />Adjust</Button>
          </form>
        )}

        {modelMissing && (
          <p className="text-xs text-status-error">No image model is set. <Link to="/control/article-settings" className="font-medium text-byword-blue hover:underline">Choose one in Article Settings</Link>.</p>
        )}
      </div>
    </BywordCard>
    </div>
  );
}
