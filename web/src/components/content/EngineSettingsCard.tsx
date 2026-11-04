import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Workflow } from "lucide-react";
import { toast } from "sonner";
import { api, type EngineSettings, type EngineSettingsResponse } from "@/lib/api";
import { useEngineSettings } from "@/hooks/useEngineSettings";
import { BywordCard, SectionHeader } from "@/components/layout/BywordSurface";
import { LiveTextModelSelect } from "@/components/content/LiveTextModelSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLES = [
  ["research_queries", "Search queries"],
  ["research_claims", "Claim extraction"],
  ["brief", "Brief"],
  ["draft", "Draft"],
  ["revise", "Revise"],
] as const;

export function EngineSettingsCard({ siteId }: { siteId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const { data } = useEngineSettings(siteId);
  const [draft, setDraft] = useState<EngineSettings>({});
  useEffect(() => { if (data) setDraft(data.settings); }, [data]);

  const save = useMutation({
    mutationFn: () => api.put<EngineSettingsResponse>("/settings/engine", { siteId, settings: draft }),
    onSuccess: (res) => {
      queryClient.setQueryData(["engine-settings", siteId], res);
      toast.success("Engine settings saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save engine settings"),
  });

  return (
    <BywordCard>
      <SectionHeader
        icon={Workflow}
        title="Engine"
        description="Models and limits for normal and deep runs. Empty uses the mode default."
        action={
          <Button onClick={() => save.mutate()} disabled={save.isPending || !data || !siteId}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
        }
      />
      <div className="grid gap-4 p-6 sm:grid-cols-2">
        {ROLES.map(([role, label]) => (
          <div key={role} className="space-y-2">
            <Label>{label} model</Label>
            <LiveTextModelSelect
              value={draft.models?.[role] ?? ""}
              onValueChange={(id) => setDraft((d) => ({ ...d, models: { ...d.models, [role]: id } }))}
              triggerClassName="h-11"
            />
          </div>
        ))}
        <div className="space-y-2">
          <Label htmlFor="engine-budget">Budget per run (USD)</Label>
          <Input
            id="engine-budget"
            type="number"
            min="0.1"
            step="0.1"
            className="h-11"
            value={draft.budgetUsd ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, budgetUsd: e.target.value ? Number(e.target.value) : undefined }))}
          />
        </div>
        <div className="space-y-2">
          <Label>Citation style</Label>
          <Select
            value={draft.citationStyle ?? "inline"}
            onValueChange={(v) => setDraft((d) => ({ ...d, citationStyle: v as "inline" | "references" }))}
          >
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inline">Inline</SelectItem>
              <SelectItem value="references">Reference list</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </BywordCard>
  );
}
