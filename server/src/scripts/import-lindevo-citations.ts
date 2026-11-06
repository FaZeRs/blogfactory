// One-off import of Lindevo's content_engine.ai_citations history into ai_answer_checks.
// bun run src/scripts/import-lindevo-citations.ts --site <siteId> --source-url <postgres url> [--dry-run]
import postgres from "postgres";
import { classify } from "../services/ai-visibility/detect.js";
import { defaultBrandTerms } from "../services/ai-visibility/settings.js";
import { questionHash } from "../services/ai-visibility/questions.js";

export type SourceRow = {
  run_key: string; question: string; engine: string; answer: string | null;
  cited_urls: string[]; lindevo_cited: boolean; lindevo_urls: string[]; asked_at: Date;
};

const ENGINES: Record<string, { engine: string; label: string }> = {
  "gemini-grounded": { engine: "google/gemini (Lindevo import)", label: "Google" },
  "openai-web": { engine: "openai/web (Lindevo import)", label: "OpenAI" },
};

/** Pure mapping of one Lindevo row; null for an engine we do not know. */
export function mapRow(r: SourceRow, site: { name: string; domain: string }) {
  const e = ENGINES[r.engine];
  if (!e) return null;
  const answer = r.answer ?? "";
  const c = classify({ answer, citations: (r.cited_urls ?? []).map((url) => ({ url })), domain: site.domain, brandTerms: defaultBrandTerms(site), competitors: [] });
  const ok = answer.trim().length > 0;
  return {
    week: r.run_key, question: r.question, questionHash: questionHash(r.question),
    engine: e.engine, engineLabel: e.label,
    status: ok ? "ok" : "failed", error: ok ? null : "empty answer (Lindevo import)", answer: r.answer?.slice(0, 4_000) ?? null, // run.ts ANSWER_CAP
    cited: r.lindevo_cited, citedUrls: r.lindevo_urls ?? [], mentioned: c.mentioned,
    otherHosts: c.otherHosts, competitorHosts: [] as string[], costUsd: 0, askedAt: r.asked_at,
  };
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const siteId = arg("site"), sourceUrl = arg("source-url"), dry = process.argv.includes("--dry-run");
  if (!siteId || !sourceUrl) throw new Error("Usage: --site <siteId> --source-url <postgres url> [--dry-run]");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const target = postgres(process.env.DATABASE_URL, { max: 1 });
  const source = postgres(sourceUrl, { max: 1 });
  try {
    const [site] = await target<{ user_id: string; name: string; domain: string }[]>`SELECT user_id, name, domain FROM sites WHERE id = ${siteId}`;
    if (!site) throw new Error("Site not found");
    const rows = await source.begin("READ ONLY", (tx) => tx<SourceRow[]>`
      SELECT run_key, question, engine, answer, cited_urls, lindevo_cited, lindevo_urls, asked_at
      FROM content_engine.ai_citations ORDER BY asked_at`);
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const m = mapRow(r, site);
      if (!m) { skipped++; continue; }
      if (dry) { inserted++; continue; }
      const res = await target`
        INSERT INTO ai_answer_checks (user_id, site_id, week, question, question_hash, engine, engine_label, status, error, answer,
          cited, cited_urls, mentioned, other_hosts, competitor_hosts, cost_usd, asked_at)
        VALUES (${site.user_id}, ${siteId}, ${m.week}, ${m.question}, ${m.questionHash}, ${m.engine}, ${m.engineLabel}, ${m.status}, ${m.error}, ${m.answer},
          ${m.cited}, ${m.citedUrls}, ${m.mentioned}, ${m.otherHosts}, ${m.competitorHosts}, 0, ${m.askedAt})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (res.length) inserted++; else skipped++;
    }
    console.log(`${dry ? "[dry-run] " : ""}read ${rows.length}, ${dry ? "would insert" : "inserted"} ${inserted}, skipped ${skipped}`);
  } finally {
    await source.end(); await target.end();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
