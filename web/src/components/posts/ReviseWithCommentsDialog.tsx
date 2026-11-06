import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, MessageSquareText } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MIN = 10;
const MAX = 4000;

export type RevisedPost = { title: string; content: string; summary: string | null; coverImageUrl: string | null; inlineImages: string[] | null };

type Props = {
  postId: string;
  updatedAt: string;
  disabled?: boolean;
  disabledReason?: string;
  onRevised: (post: RevisedPost) => void;
  /** Reloads the post from the server after a 409. */
  onReload: () => Promise<void> | void;
};

export function ReviseWithCommentsDialog({ postId, updatedAt, disabled, disabledReason, onRevised, onReload }: Props) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState("");
  const [stale, setStale] = useState(false);

  const revise = useMutation({
    mutationFn: () => api.post<RevisedPost>(`/posts/${postId}/revise-with-comments`, { comments: comments.trim(), expectedUpdatedAt: updatedAt }),
    onSuccess: (post) => {
      onRevised(post);
      setOpen(false);
      setComments("");
      toast.success("Revised; the previous version is in revisions");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setStale(true);
      else toast.error("Could not revise: " + error.message);
    },
  });

  const length = comments.trim().length;
  const busy = revise.isPending;
  const valid = length >= MIN && length <= MAX;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (next) setStale(false); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} title={disabled ? disabledReason : undefined}>
          <MessageSquareText className="mr-1.5 h-4 w-4" />
          Revise with comments
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Revise with comments</DialogTitle>
          <DialogDescription>Write what to change. You can quote passages. The current version stays in revisions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="revise-comments" className="text-xs text-muted-foreground">Comments</Label>
          <Textarea
            id="revise-comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            disabled={busy}
            rows={8}
            maxLength={MAX}
            placeholder={'Shorten the intro. Add a worked example under "Pricing". Remove the second FAQ.'}
          />
          <p className="text-right font-mono text-[11px] text-muted-foreground">{length} / {MAX}</p>
        </div>
        {stale && (
          <Alert variant="warning" role="alert">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              This post changed since you opened it. Reload it, then revise again.
              <Button size="sm" variant="outline" onClick={async () => { await onReload(); setStale(false); setOpen(false); }}>Reload post</Button>
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { setStale(false); revise.mutate(); }} disabled={busy || !valid || stale}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {busy ? "Revising…" : "Revise"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
