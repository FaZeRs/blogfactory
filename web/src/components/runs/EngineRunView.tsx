import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, Circle, ExternalLink, Loader2, XCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { EngineRunDetail, EngineStageRun } from "@/lib/api";

type Details = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const STEPS: Record<string, { title: string; about: string }> = {
  research: { title: "Research", about: "Searches the web, reads the best sources and keeps only claims backed by an exact quote." },
  brief: { title: "Plan", about: "Picks the angle, title and outline, and assigns evidence to each section." },
  draft: { title: "Write", about: "Writes the article from the plan, citing the verified claims." },
  gates: { title: "Quality checks", about: "Checks sources, links, length, structure, copying and brand voice." },
  review: { title: "Review", about: "Fact-checks the draft against the evidence and reads it as your audience would." },
  revise: { title: "Revise", about: "Fixes the problems the quality checks found." },
  localize: { title: "Translate", about: "Translates the article into the languages enabled for this site and checks each translation." },
  deliver: { title: "Deliver", about: "Saves the draft to your Review Queue." },
};
const ORDER = ["research", "brief", "draft", "gates", "review", "deliver"];

const GATES: Record<string, string> = {
  citations: "Claims cite verified sources",
  components: "Lindevo components",
  factcheck: "Fact-check against the evidence",
  faq: "FAQ answers the planned questions",
  links: "Links work",
  "links-warnings": "Link warnings",
  meta: "Title, description and length",
  overlap: "No text copied from sources",
  reader: "Reader review",
  similarity: "Not a duplicate of your posts",
  structure: "Headings and structure",
  style: "Style",
  "style-warnings": "Style suggestions",
  voice: "Brand voice rules",
  "voice-warnings": "Brand voice suggestions",
};

function duration(stage: EngineStageRun) {
  if (!stage.finishedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function summary(stage: EngineStageRun, d: Details): string {
  switch (stage.stage) {
    case "research":
      return `${num(d.sourceCount) ?? 0} sources read · ${num(d.verifiedCount) ?? 0} of ${num(d.claimCount) ?? 0} claims verified`;
    case "brief":
      return text(d.chosenTitle);
    case "draft":
    case "revise":
      return `${num(d.words)?.toLocaleString() ?? "?"} words`;
    case "gates":
      if (d.passed) return "All checks passed";
      return `${num(d.blockerCount) ?? 0} problem${num(d.blockerCount) === 1 ? "" : "s"} found${d.escalated ? " · needs your review" : " · sent to revise"}`;
    case "review":
      // Normal mode runs only the fact-check, so the summary does not name the reader review.
      if (d.passed) return "Review passed";
      return `${num(d.blockerCount) ?? 0} problem${num(d.blockerCount) === 1 ? "" : "s"} found${d.escalated ? " · needs your review" : " · sent to revise"}`;
    case "localize": {
      const made = list(d.locales).filter((l) => text((l as Details).status) !== "failed").length;
      return `${made} of ${list(d.locales).length} translation${list(d.locales).length === 1 ? "" : "s"} made`;
    }
    case "deliver":
      return d.escalated ? "Saved to Review Queue with open problems" : "Saved to Review Queue";
    default:
      return "";
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-status-running" aria-label="Running" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-status-error" aria-label="Failed" />;
  if (status === "pending") return <Circle className="h-4 w-4 text-byword-border" aria-label="Not started" />;
  return <CheckCircle2 className="h-4 w-4 text-status-success" aria-label="Done" />;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="type-kicker mb-1.5">{children}</p>;
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blue" }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded border px-1.5 py-0.5 text-xs",
      tone === "blue" ? "border-byword-blue/30 bg-byword-blue-soft text-byword-blue" : "border-border bg-muted/40 text-foreground",
    )}>
      {children}
    </span>
  );
}

function Competitors({ d }: { d: Details }) {
  const rows = list(d.competitors) as Details[];
  const a = (d.serpAnalysis ?? null) as Details | null;
  const gain = list(a?.informationGain) as Details[];
  const items = (label: string, v: unknown[]) =>
    v.length ? (
      <div>
        <Label>{label}</Label>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">{v.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
      </div>
    ) : null;
  if (!rows.length && !list(d.questions).length) return null;
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div>
          <Label>Competitors ({rows.length}){num(a?.typicalLength) ? ` · typically ${num(a?.typicalLength)?.toLocaleString()} words` : ""}</Label>
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((c, i) => (
              <li key={`${text(c.url)}-${i}`} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <a href={text(c.url)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-byword-blue hover:underline">{text(c.title) || text(c.url)}</a>
                  <span className="shrink-0 text-xs text-muted-foreground">{host(text(c.url))} · {num(c.words)?.toLocaleString() ?? "?"} words</span>
                </div>
                {list(c.outline).length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {(list(c.outline) as Details[]).map((h, j) => <li key={j} className={num(h.level) === 3 ? "pl-4" : ""}>{text(h.text)}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {a && items("Gaps competitors leave", list(a.gaps))}
      {gain.length > 0 && items("Information gain", gain.map((g) => text(g.point)))}
      {items("Questions people ask", list(d.questions))}
    </div>
  );
}

function ResearchBody({ d, engine }: { d: Details; engine: EngineRunDetail }) {
  const [showAll, setShowAll] = useState(false);
  const sources = engine.sources ?? [];
  const evidence = engine.evidence ?? [];
  const verified = evidence.filter((e) => e.verified);
  const shown = showAll ? evidence : verified;
  const sourceHost = new Map(sources.map((s) => [s.id, host(s.url)]));
  return (
    <div className="space-y-4">
      <div>
        <Label>Searched for · via {text(d.searchAdapter) === "dataforseo" ? "DataForSEO" : text(d.searchAdapter) === "searxng" ? "SearXNG" : "no search"}</Label>
        <div className="flex flex-wrap gap-1.5">{list(d.queries).map((q) => <Chip key={String(q)}>{String(q)}</Chip>)}</div>
      </div>
      <div>
        <Label>Sources read ({sources.length}{num(d.skippedSources) ? `, ${num(d.skippedSources)} skipped` : ""})</Label>
        <ul className="divide-y divide-border rounded-md border border-border">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-byword-blue hover:underline">
                {s.title || s.url}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">{host(s.url)}</span>
              <Chip>{s.fetchedVia === "crawl4ai" ? "Crawl4AI" : "Direct fetch"}</Chip>
            </li>
          ))}
        </ul>
      </div>
      <Competitors d={d} />
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="type-kicker">{showAll ? `All claims (${evidence.length})` : `Verified claims (${verified.length})`}</p>
          {evidence.length > verified.length && (
            <button type="button" className="text-xs text-byword-blue hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Only verified" : `Show ${evidence.length - verified.length} rejected`}
            </button>
          )}
        </div>
        <ul className="space-y-2">
          {shown.map((e, i) => (
            <li key={`${e.claimId}-${i}`} className="rounded-md border border-border p-3 text-sm">
              <div className="flex items-start gap-2">
                {e.claimId && <Chip tone="blue">{e.claimId}</Chip>}
                <p className="flex-1">{e.claim}</p>
                {e.verified
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 text-status-success" aria-label="Verified" />
                  : <XCircle className="h-4 w-4 shrink-0 text-status-error" aria-label="Not verified" />}
              </div>
              <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                “{e.quote}” <span className="whitespace-nowrap">— {sourceHost.get(e.sourceId) ?? "source"}</span>
              </blockquote>
              {!e.verified && e.reason && <p className="mt-1 text-xs text-status-error">Rejected: {e.reason.replace(/_/g, " ")}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BriefBody({ d }: { d: Details }) {
  const kw = (d.keywordData ?? null) as { volume: number | null; difficulty: number | null; intent: string | null } | null;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <Label>Angle</Label>
        <p>{text(d.angle)}</p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <Label>Main keyword</Label>
          <p>{text(d.primaryKeyword)}</p>
        </div>
        {kw && (
          <div>
            <Label>Search data</Label>
            <p>
              {kw.volume != null && `${kw.volume.toLocaleString()} searches/month`}
              {kw.difficulty != null && ` · difficulty ${kw.difficulty}`}
              {kw.intent && ` · ${kw.intent} intent`}
            </p>
          </div>
        )}
      </div>
      <div>
        <Label>Title options</Label>
        <ul className="space-y-1">
          {list(d.titleOptions).map((t) => (
            <li key={String(t)} className={cn(String(t) === text(d.chosenTitle) ? "font-semibold" : "text-muted-foreground")}>
              {String(t) === text(d.chosenTitle) && "✓ "}{String(t)}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <Label>Outline</Label>
        <ol className="space-y-2">
          {list(d.outline).map((raw, i) => {
            const s = raw as { heading?: string; purpose?: string; words?: number; claimIds?: string[] };
            return (
              <li key={i} className="rounded-md border border-border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium">{s.heading}</p>
                  {s.words != null && <span className="shrink-0 text-xs text-muted-foreground">~{s.words} words</span>}
                </div>
                {s.purpose && <p className="mt-1 text-xs text-muted-foreground">{s.purpose}</p>}
                {!!s.claimIds?.length && (
                  <div className="mt-2 flex flex-wrap gap-1">{s.claimIds.map((c) => <Chip key={c} tone="blue">{c}</Chip>)}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {list(d.faq).length > 0 && (
        <div>
          <Label>FAQ questions</Label>
          <ul className="list-disc space-y-1 pl-5">{list(d.faq).map((q) => <li key={String(q)}>{String(q)}</li>)}</ul>
        </div>
      )}
      {list(d.internalLinks).length > 0 && (
        <div>
          <Label>Links to your site</Label>
          <ul className="space-y-1">
            {list(d.internalLinks).map((raw, i) => {
              const l = raw as { url?: string; anchorText?: string };
              return <li key={i}><span className="font-medium">{l.anchorText}</span> <span className="text-muted-foreground">→ {l.url}</span></li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function issueText(issues: unknown) {
  return list(issues).map((i) => text((i as { message?: unknown }).message)).filter(Boolean);
}

const REVIEW_GATES = ["factcheck", "reader"];

/** The gates and the review share attempt numbers, so each stage shows only its own gate rows. */
function GatesBody({ d, attempt, engine, review }: { d: Details; attempt: number; engine: EngineRunDetail; review?: boolean }) {
  const rows = (engine.gates ?? []).filter((g) => g.attempt === attempt && REVIEW_GATES.includes(g.gate) === Boolean(review));
  const blockers = rows.filter((g) => g.severity !== "warning");
  const warnings = rows.filter((g) => g.severity === "warning" && !g.passed);
  return (
    <div className="space-y-3 text-sm">
      {rows.length === 0 && issueText(d.blockers).map((m) => <p key={m} className="text-status-error">{m}</p>)}
      <ul className="space-y-1.5">
        {blockers.map((g) => (
          <li key={g.gate} className="flex items-start gap-2">
            {g.passed
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-success" aria-label="Passed" />
              : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" aria-label="Failed" />}
            <div>
              <p>{GATES[g.gate] ?? g.gate}</p>
              {issueText(g.issues).map((m) => <p key={m} className="text-xs text-status-error">{m}</p>)}
            </div>
          </li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <div>
          <Label>Suggestions (don't block)</Label>
          <ul className="space-y-1">
            {warnings.flatMap((g) => issueText(g.issues).map((m) => <li key={g.gate + m} className="text-xs text-muted-foreground">• {m}</li>))}
          </ul>
        </div>
      )}
      {text(d.reason) && <p className="text-xs text-status-error">{text(d.reason)}</p>}
    </div>
  );
}

function StageBody({ stage, engine }: { stage: EngineStageRun; engine: EngineRunDetail }) {
  const d = stage.details ?? {};
  if (stage.status === "failed") return <p className="text-sm text-status-error">{stage.error ?? "This attempt failed and was retried."}</p>;
  switch (stage.stage) {
    case "research":
      return <ResearchBody d={d} engine={engine} />;
    case "brief":
      return <BriefBody d={d} />;
    case "gates":
      return <GatesBody d={d} attempt={stage.attempt} engine={engine} />;
    case "review":
      return <GatesBody d={d} attempt={stage.attempt} engine={engine} review />;
    case "draft":
    case "revise":
      return <p className="text-sm">“{text(d.title)}” · {num(d.words)?.toLocaleString()} words. The full text is on the draft.</p>;
    case "localize":
      return (
        <ul className="space-y-1 text-sm">
          {list(d.locales).map((l) => {
            const x = l as Details;
            return (
              <li key={text(x.locale)}>
                <span className="font-medium">{text(x.locale)}</span>
                {": "}
                {text(x.status) === "failed" ? <span className="text-status-error">{text(x.error) || "Translation failed"}</span> : text(x.status) === "ready" ? "ready" : `needs review (${num(x.blockers) ?? 0} problem${num(x.blockers) === 1 ? "" : "s"})`}
              </li>
            );
          })}
        </ul>
      );
    case "deliver":
      return text(d.postId) ? (
        <div className="flex flex-wrap gap-3 text-sm">
          <Link to={`/library/posts/${text(d.postId)}/edit`} className="inline-flex items-center gap-1 text-byword-blue hover:underline">
            Open draft <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          <Link to="/review" className="inline-flex items-center gap-1 text-byword-blue hover:underline">Review Queue</Link>
        </div>
      ) : null;
    default:
      return null;
  }
}

function StepRow({ stage, engine, defaultOpen }: { stage: EngineStageRun; engine: EngineRunDetail; defaultOpen?: boolean }) {
  const meta = STEPS[stage.stage] ?? { title: stage.stage, about: "" };
  const d = stage.details ?? {};
  const done = stage.status === "succeeded" || stage.status === "reused";
  const line = stage.status === "running" ? meta.about : stage.status === "failed" ? `Attempt ${stage.attempt} failed · retried` : summary(stage, d);
  const expandable = done || stage.status === "failed";
  const time = duration(stage);
  return (
    <Collapsible defaultOpen={defaultOpen} disabled={!expandable} className="group">
      <CollapsibleTrigger className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-calm hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent">
        <span className="mt-0.5"><StatusIcon status={stage.status} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{meta.title}</span>
          <span className={cn("block truncate text-xs", stage.status === "failed" ? "text-status-error" : "text-muted-foreground")}>{line}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          {time && <span className="block">{time}</span>}
          {stage.costUsd > 0 && <span className="block">${stage.costUsd.toFixed(2)}</span>}
        </span>
        {expandable && <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />}
      </CollapsibleTrigger>
      {expandable && (
        <CollapsibleContent className="border-t border-border bg-muted/20 px-3 py-3 sm:pl-10">
          <StageBody stage={stage} engine={engine} />
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

const MODE_LABEL = { normal: "Normal", deep: "Deep" } as const;
const STATE_LABEL: Record<string, string> = { active: "Working", done: "Done", failed: "Failed", escalated: "Needs review" };

/** The staged engine's run, step by step: what each stage did, what it found and what it cost. */
export function EngineRunView({ engine }: { engine: EngineRunDetail }) {
  const startedStages = new Set(engine.stages.map((s) => s.stage));
  const active = engine.state === "active";
  const pending: EngineStageRun[] = active
    ? ORDER.filter((k) => !startedStages.has(k)).map((stage) => ({
      stage, attempt: 0, status: "pending", model: null, costUsd: 0, startedAt: "", finishedAt: null, error: null,
    }))
    : [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{MODE_LABEL[engine.mode] ?? engine.mode} mode</span>
        <span>{STATE_LABEL[engine.state] ?? engine.state}</span>
        <span>${engine.spent_usd.toFixed(2)} of ${engine.budget_usd.toFixed(2)} budget</span>
      </div>
      {engine.state_reason && engine.state !== "active" && engine.state !== "done" && (
        <p className="rounded-md border border-status-error/30 bg-status-error/5 px-3 py-2 text-xs text-status-error">{engine.state_reason}</p>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card" aria-label="How this article was made">
        {engine.stages.map((s) => (
          <StepRow key={`${s.stage}-${s.attempt}`} stage={s} engine={engine} />
        ))}
        {pending.map((s) => (
          <div key={s.stage} className="flex items-start gap-3 px-3 py-2.5 opacity-60">
            <span className="mt-0.5"><StatusIcon status="pending" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{STEPS[s.stage].title}</span>
              <span className="block truncate text-xs text-muted-foreground">{STEPS[s.stage].about}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
