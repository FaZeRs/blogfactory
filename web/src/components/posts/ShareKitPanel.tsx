import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BywordCard } from "@/components/layout/BywordSurface";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type ShareKit = { linkedin: string; thread: string[]; newsletter: string; quotes: string[]; teaser: string };
type ShareKitResponse = { share_kit: { kit: ShareKit; createdAt: string; stale: boolean } | null };

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard is not available");
  }
}

function Piece({ label, text, copy }: { label: string; text: React.ReactNode; copy: string }) {
  return (
    <div className="grid gap-1.5 border-t border-byword-border pt-3 sm:grid-cols-[130px_minmax(0,1fr)_auto] sm:items-start">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 whitespace-pre-line break-words text-sm text-foreground">{text}</div>
      <Button variant="ghost" size="sm" className="justify-self-start" aria-label={`Copy ${label}`} onClick={() => copyText(copy, label)}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Social copy written from the saved post on request; the owner copies it by hand, nothing is posted. */
export function ShareKitPanel({ postId, unsaved }: { postId: string; unsaved?: boolean }) {
  const queryClient = useQueryClient();
  const key = ["post-share-kit", postId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<ShareKitResponse>(`/posts/${postId}/share-kit`) });
  const create = useMutation({
    mutationFn: () => api.post<ShareKitResponse>(`/posts/${postId}/share-kit`, {}),
    onSuccess: (res) => { queryClient.setQueryData(key, res); toast.success("Share kit ready"); },
    onError: (error) => toast.error("Could not write the share kit: " + error.message),
  });
  const saved = data?.share_kit ?? null;
  const kit = saved?.kit;
  const busy = create.isPending;

  return (
    <BywordCard className="mb-8 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-label">Share kit</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Posts for LinkedIn, a short thread, a newsletter blurb and pull quotes, written from the saved article. Copy them by hand; nothing is posted.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => create.mutate()} disabled={busy || isLoading || unsaved} title={unsaved ? "Save changes first" : undefined}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Share2 className="mr-1.5 h-4 w-4" />}
          {busy ? "Writing…" : kit ? "Write again" : "Create share kit"}
        </Button>
      </div>
      {saved?.stale && (
        <Alert variant="warning" className="mt-4">
          <AlertDescription>The article changed after this kit was written. Write it again to match.</AlertDescription>
        </Alert>
      )}
      {kit && (
        <div className="mt-5 space-y-3">
          <Piece label="LinkedIn" text={kit.linkedin} copy={kit.linkedin} />
          <Piece
            label="Thread"
            text={<ol className="list-decimal space-y-1.5 pl-5">{kit.thread.map((p, i) => <li key={i}>{p}</li>)}</ol>}
            copy={kit.thread.join("\n\n")}
          />
          <Piece label="Newsletter" text={kit.newsletter} copy={kit.newsletter} />
          {kit.quotes.length > 0 && (
            <Piece label="Pull quotes" text={<ul className="space-y-1.5">{kit.quotes.map((q, i) => <li key={i}>“{q}”</li>)}</ul>} copy={kit.quotes.join("\n\n")} />
          )}
          <Piece label="Teaser" text={kit.teaser} copy={kit.teaser} />
        </div>
      )}
    </BywordCard>
  );
}
