import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Languages, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BywordCard, SectionHeader } from "@/components/layout/BywordSurface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LOCALE_RE, LOCALIZATION_LIMITS, localizationKey, type LocaleSetting, type LocalizationSettings } from "@/lib/localization";

const EMPTY: LocalizationSettings = { enabled: false, locales: [] };

export function LocalizationCard({ siteId }: { siteId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: localizationKey(siteId),
    queryFn: async () => (await api.get<{ settings: LocalizationSettings }>(`/settings/localization?siteId=${siteId}`)).settings,
    enabled: !!siteId,
  });
  const [draft, setDraft] = useState<LocalizationSettings>(EMPTY);
  useEffect(() => { if (data) setDraft(data); }, [data]);

  const save = useMutation({
    mutationFn: async () => (await api.put<{ settings: LocalizationSettings }>("/settings/localization", { siteId, settings: draft })).settings,
    onSuccess: (settings) => {
      queryClient.setQueryData(localizationKey(siteId), settings);
      setDraft(settings);
      toast.success("Localization saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save localization"),
  });

  const setLocale = (index: number, patch: Partial<LocaleSetting>) =>
    setDraft((d) => ({ ...d, locales: d.locales.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));
  const invalid = draft.locales.some((l, i) => !LOCALE_RE.test(l.locale) || draft.locales.findIndex((o) => o.locale === l.locale) !== i);

  return (
    <BywordCard>
      <SectionHeader
        icon={Languages}
        title="Localization"
        description="Translate finished articles into more languages. A failed translation never blocks the English draft."
        action={
          <Button onClick={() => save.mutate()} disabled={save.isPending || !data || !siteId || invalid}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
        }
      />
      <div className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <Switch id="localization-enabled" checked={draft.enabled} onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
          <Label htmlFor="localization-enabled">Translate this site's articles</Label>
        </div>
        {draft.locales.map((l, i) => (
          <section key={i} aria-label={`Language ${l.locale || i + 1}`} className="space-y-4 rounded-md border border-byword-border p-4">
            <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-2">
                <Label htmlFor={`loc-code-${i}`}>Code</Label>
                <Input id={`loc-code-${i}`} value={l.locale} placeholder="lv" maxLength={5} aria-invalid={!LOCALE_RE.test(l.locale)}
                  onChange={(e) => setLocale(i, { locale: e.target.value.trim() })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`loc-name-${i}`}>Name</Label>
                <Input id={`loc-name-${i}`} value={l.name} placeholder="Latvian" maxLength={40} onChange={(e) => setLocale(i, { name: e.target.value })} />
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${l.name || l.locale || "language"}`}
                onClick={() => setDraft((d) => ({ ...d, locales: d.locales.filter((_, j) => j !== i) }))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Glossary</Label>
              {l.glossary.map((g, gi) => (
                <div key={gi} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  {(["source", "target", "note"] as const).map((field) => (
                    <Input key={field} aria-label={`Glossary ${field} ${gi + 1}`} placeholder={field === "source" ? "English term" : field === "target" ? "Translation" : "Note (optional)"}
                      value={g[field] ?? ""} onChange={(e) => setLocale(i, { glossary: l.glossary.map((x, xi) => (xi === gi ? { ...x, [field]: e.target.value } : x)) })} />
                  ))}
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove glossary row ${gi + 1}`}
                    onClick={() => setLocale(i, { glossary: l.glossary.filter((_, xi) => xi !== gi) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={l.glossary.length >= LOCALIZATION_LIMITS.glossary}
                onClick={() => setLocale(i, { glossary: [...l.glossary, { source: "", target: "" }] })}>
                <Plus className="mr-1.5 h-4 w-4" />Add term
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`loc-style-${i}`}>Style guide</Label>
              <Textarea id={`loc-style-${i}`} rows={6} maxLength={20_000} value={l.styleGuide} placeholder="Tone, form of address, heading conventions."
                onChange={(e) => setLocale(i, { styleGuide: e.target.value })} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`loc-forbidden-${i}`}>Forbidden informal forms</Label>
              <Input key={(l.formalAddress?.forbidden ?? []).join()} id={`loc-forbidden-${i}`} placeholder="Comma separated, e.g. tu, tev" defaultValue={(l.formalAddress?.forbidden ?? []).join(", ")}
                onBlur={(e) => {
                  const forbidden = e.target.value.split(",").map((w) => w.trim()).filter(Boolean);
                  setLocale(i, { formalAddress: forbidden.length ? { forbidden } : undefined });
                }} />
            </div>
          </section>
        ))}
        <Button type="button" variant="outline" disabled={draft.locales.length >= LOCALIZATION_LIMITS.locales}
          onClick={() => setDraft((d) => ({ ...d, locales: [...d.locales, { locale: "", name: "", glossary: [], styleGuide: "" }] }))}>
          <Plus className="mr-1.5 h-4 w-4" />Add language
        </Button>
        {invalid && <p className="text-xs text-status-error">Each language needs a unique code such as lv or pt-BR.</p>}
      </div>
    </BywordCard>
  );
}
