import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EngineAvailability, EngineMode } from "@/lib/api";

const REASONS: Record<string, string> = {
  worker_required: "Needs a background worker",
  ai_key_missing: "Add an OpenRouter key in Settings first",
};

const ABOUT: Record<EngineMode, { text: string; time: string }> = {
  fast: { text: "One AI pass from your source. No web research or fact checks.", time: "About 15 seconds per draft" },
  normal: { text: "Researches the web, keeps only claims backed by a quote, plans, writes and checks the draft.", time: "Usually 2–4 minutes" },
  deep: { text: "More sources, search data and a stronger writer, with up to two revision passes.", time: "Usually 4–8 minutes" },
};

const adapter = (name: string, on: boolean) => `${name} ${on ? "✓" : "—"}`;

export function GenerationModeSelect({
  value,
  onChange,
  availability,
  estimates,
  sourceType,
}: {
  value: EngineMode;
  onChange: (mode: EngineMode) => void;
  availability?: EngineAvailability;
  estimates?: { normal: number; deep: number };
  sourceType: string;
}) {
  const sourceOk = sourceType === "article_keyword" || sourceType === "article_title";
  const disabledReason = !sourceOk
    ? "Keyword or title only"
    : availability && !availability.available
      ? (availability.reason && REASONS[availability.reason]) || "Unavailable"
      : availability ? null : "Loading";
  const estimate = value === "fast" ? null : estimates?.[value];

  return (
    <div className="space-y-2">
      <Tabs value={value} onValueChange={(v) => onChange(v as EngineMode)}>
        <TabsList aria-label="Generation mode">
          <TabsTrigger value="fast">Fast</TabsTrigger>
          {(["normal", "deep"] as const).map((mode) => (
            <TabsTrigger key={mode} value={mode} disabled={!!disabledReason} title={disabledReason ?? undefined}>
              {mode === "normal" ? "Normal" : "Deep"}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <p className="text-sm text-muted-foreground">
        {ABOUT[value].text} <span className="whitespace-nowrap">{ABOUT[value].time}.</span>
      </p>
      {disabledReason && disabledReason !== "Loading" && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {availability && value !== "fast" && (
        <p className="text-xs text-muted-foreground">
          {estimate != null && `≈ $${estimate.toFixed(2)} estimated · `}
          {adapter("SearXNG", availability.adapters.searxng)} · {adapter("Crawl4AI", availability.adapters.crawl4ai)} ·{" "}
          {adapter("DataForSEO", availability.adapters.dataforseo)}
        </p>
      )}
    </div>
  );
}
