import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EngineAvailability, EngineMode } from "@/lib/api";

const REASONS: Record<string, string> = {
  worker_required: "Needs a background worker",
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
      {disabledReason && disabledReason !== "Loading" && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {availability && (
        <p className="text-xs text-muted-foreground">
          {estimate != null && `≈ $${estimate.toFixed(2)} estimated · `}
          {adapter("SearXNG", availability.adapters.searxng)} · {adapter("Crawl4AI", availability.adapters.crawl4ai)} ·{" "}
          {adapter("DataForSEO", availability.adapters.dataforseo)}
        </p>
      )}
    </div>
  );
}
