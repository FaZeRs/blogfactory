export function statusTone(status: string) {
  if (status === "failed") return { bar: "bg-status-error", text: "text-status-error" };
  if (status === "running") return { bar: "bg-status-running", text: "text-status-running" };
  if (status === "pending") return { bar: "bg-byword-border", text: "text-muted-foreground" };
  return { bar: "bg-status-success", text: "text-status-success" };
}
