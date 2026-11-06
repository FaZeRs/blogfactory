import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Languages, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BywordCard } from "@/components/layout/BywordSurface";
import { MarkdownEditor } from "@/components/posts/MarkdownEditor";
import { StatusBadge } from "@/components/ui/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ENGLISH, localizationKey, translationBadges, translationsKey, type LocalizationSettings, type PostTranslation } from "@/lib/localization";

/**
 * The language switcher above the post editor, and the translation view when a language other than English is chosen.
 * It renders nothing when the site has no enabled languages.
 */
export function TranslationPanel({ postId, siteId, locale, onLocale }: { postId: string; siteId: string | null | undefined; locale: string; onLocale: (locale: string) => void }) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: localizationKey(siteId),
    queryFn: async () => (await api.get<{ settings: LocalizationSettings }>(`/settings/localization?siteId=${siteId}`)).settings,
    enabled: !!siteId,
  });
  const locales = settings?.enabled ? settings.locales : [];
  const { data: translations = [] } = useQuery({
    queryKey: translationsKey(postId),
    queryFn: async () => (await api.get<{ translations: PostTranslation[] }>(`/posts/${postId}/translations`)).translations,
    enabled: locales.length > 0,
    refetchInterval: (query) => (query.state.data?.some((t) => t.status === "running") ? 3_000 : false),
  });
  const lost = !!settings && locale !== ENGLISH && !locales.some((l) => l.locale === locale);
  useEffect(() => { if (lost) onLocale(ENGLISH); }, [lost, onLocale]);
  if (!locales.length) return null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: translationsKey(postId) });
  const byLocale = new Map(translations.map((t) => [t.locale, t]));
  const active = locales.find((l) => l.locale === locale);

  return (
    <div className="mb-6 space-y-4">
      <div role="tablist" aria-label="Language" className="flex flex-wrap items-center gap-1">
        <Languages className="mr-1 h-4 w-4 text-muted-foreground" aria-hidden />
        {[{ locale: ENGLISH, name: "English" }, ...locales].map((l) => {
          const t = byLocale.get(l.locale);
          return (
            <button key={l.locale} type="button" role="tab" aria-selected={locale === l.locale} onClick={() => onLocale(l.locale)}
              className={cn("flex items-center gap-2 rounded-sm border px-3 py-2 text-xs font-semibold transition-calm",
                locale === l.locale ? "border-byword-blue bg-byword-blue-soft text-byword-blue" : "border-transparent text-muted-foreground hover:border-byword-border hover:bg-card hover:text-foreground")}>
              {l.name}
              {t && translationBadges(t).map((b) => <StatusBadge key={b.label} status={b.status} label={b.label} showIcon={false} />)}
            </button>
          );
        })}
      </div>
      {active && <TranslationView postId={postId} locale={active.locale} name={active.name} translation={byLocale.get(active.locale)} onChanged={refresh} />}
    </div>
  );
}

function TranslationView({ postId, locale, name, translation, onChanged }: { postId: string; locale: string; name: string; translation: PostTranslation | undefined; onChanged: () => void }) {
  const [form, setForm] = useState({ title: "", slug: "", description: "", content: "", imageAlt: "" });
  // Reset the form whenever the server copy changes (a finished run, a save, another tab).
  useEffect(() => {
    if (translation) setForm({ title: translation.title, slug: translation.slug, description: translation.description, content: translation.content, imageAlt: translation.imageAlt });
  }, [translation?.updatedAt, translation?.locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = translation?.status === "running";
  const hasText = !!translation && translation.content.trim() !== "";
  const dirty = !!translation && (form.title !== translation.title || form.slug !== translation.slug || form.description !== translation.description || form.content.trimEnd() !== translation.content.trimEnd() || form.imageAlt !== translation.imageAlt);

  const run = useMutation({
    mutationFn: () => api.post(`/posts/${postId}/translations/${locale}/run`),
    onSuccess: () => { toast.success(`Translating to ${name}`); onChanged(); },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not start the translation"),
  });
  const save = useMutation({
    mutationFn: () => api.put(`/posts/${postId}/translations/${locale}`, { ...form, content: form.content.trimEnd(), expectedUpdatedAt: translation?.updatedAt }),
    onSuccess: () => { toast.success("Translation saved"); onChanged(); },
    onError: (err) => toast.error("Failed to save: " + (err instanceof Error ? err.message : "unknown error")),
  });

  return (
    <BywordCard className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="section-label">{name} translation</p>
          {translation && translationBadges(translation).map((b) => <StatusBadge key={b.label} status={b.status} label={b.label} />)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasText && !running && (
            <Button size="sm" variant="outline" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
              {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}Save
            </Button>
          )}
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || running || dirty}>
            {(run.isPending || running) && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {running ? "Translating" : hasText ? "Update translation" : "Translate"}
          </Button>
        </div>
      </div>
      {dirty && <p className="text-xs text-muted-foreground">Save your edits before updating the translation.</p>}
      {translation?.stale && <Alert variant="warning"><AlertDescription>The English changed after this translation was made. It is not sent to the CMS until you update it.</AlertDescription></Alert>}
      {translation?.status === "needs_review" && (
        <Alert variant="warning">
          <AlertDescription>
            <p>This translation needs review before it is sent to the CMS. Fix it below or update the translation.</p>
            {translation.findings.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {translation.findings.map((f, i) => <li key={i}>{f.message}{f.excerpt ? <> <q>{f.excerpt}</q></> : null}{f.hint ? <span className="text-muted-foreground"> {f.hint}</span> : null}</li>)}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      {!translation && <p className="text-sm text-muted-foreground">Not translated yet.</p>}
      {running && !hasText && <p className="text-sm text-muted-foreground">The translation is being made. This page updates when it is done.</p>}
      {hasText && (
        <fieldset disabled={running} className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="tr-title">Title</Label><Input id="tr-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="tr-slug">Slug</Label><Input id="tr-slug" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="tr-description">Description</Label><Textarea id="tr-description" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="tr-alt">Cover image alt text</Label><Input id="tr-alt" value={form.imageAlt} onChange={(e) => setForm((f) => ({ ...f, imageAlt: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label>Content</Label><MarkdownEditor value={form.content} onChange={(content) => setForm((f) => ({ ...f, content }))} className="min-h-[500px]" /></div>
        </fieldset>
      )}
    </BywordCard>
  );
}
