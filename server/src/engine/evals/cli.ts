import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDataForSeoClient } from "../adapters/dataforseo.js";
import { createEngineLlm, engineAiEndpoint, type EngineEndpoint } from "../adapters/llm.js";
import { createPageReader } from "../adapters/reader.js";
import { createSearchClient } from "../adapters/search.js";
import { MODE_PRESETS } from "../modes.js";
import type { ArticleRunRow, StageContext } from "../runtime/stage.js";
import { researchCore } from "../stages/research/index.js";
import { RateLimitError } from "../types.js";
import { briefFromResearch, nextBriefId } from "./record.js";
import { parseEvalMode, runEval, type ChatFn, type EvalMode } from "./run.js";
import { EVALS_DIR, loadEvalBriefFiles, loadEvalBriefs } from "./schema.js";

const OUT_DIR = fileURLToPath(new URL("../../../.eval/", import.meta.url));

const USAGE = `Usage:
  npm run eval:engine -- [--mode fast|normal|deep]... [--briefs <glob>] [--judge-model <id>] [--out <path>]
  npm run eval:engine -- --record-brief "<topic>" --locale <code>

Evaluates the generation modes on frozen briefs (no research, no network for evidence) and judges the
articles with a rubric and pairwise against the first --mode (the baseline). Default modes: fast normal.

  --mode <m>            fast | normal | deep, optionally @<model id> to run every role on that model
                        (e.g. normal@deepseek/deepseek-v4-flash), and #noreview to skip the review stage;
                        repeatable; the first one is the baseline
  --briefs <glob>       brief files to use (default: every file in src/engine/evals/briefs)
  --judge-model <id>    model that scores and compares (default: ${MODE_PRESETS.deep.models.draft})
  --out <path>          report file (default: server/.eval/<timestamp>.json)
  --record-brief <t>    run the real research stage once for topic <t> and write a new frozen brief
                        into src/engine/evals/briefs/ instead of evaluating; review the file by hand
  --locale <code>       locale for --record-brief (default: en)

Environment: OPENROUTER_API_KEY, or ENGINE_AI_BASE_URL + ENGINE_AI_API_KEY; --record-brief also needs
SEARXNG_URL or DATAFORSEO_LOGIN/PASSWORD, and optionally CRAWL4AI_URL.`;

function chatFor(endpoint: EngineEndpoint): ChatFn {
  return async (req) => {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        max_completion_tokens: req.maxTokens,
        usage: { include: true },
      }),
      signal: req.signal,
    });
    if (res.status === 429) throw new RateLimitError("LLM rate limited (fast)");
    if (!res.ok) throw new Error(`LLM request failed (fast): HTTP ${res.status}`);
    const body: any = await res.json();
    const cost = Number(body?.usage?.cost);
    return { text: String(body?.choices?.[0]?.message?.content ?? ""), costUsd: Number.isFinite(cost) ? cost : 0 };
  };
}

async function matchFiles(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true })) out.push(f);
  if (!out.length) throw new Error(`--briefs "${pattern}" matched no files`);
  return out;
}

async function record(topic: string, locale: string, endpoint: EngineEndpoint): Promise<void> {
  let spent = 0;
  const dataForSeo = createDataForSeoClient(process.env, { monthlySpentUsd: async () => spent, recordSpend: async (usd) => { spent += usd; } });
  const run = { id: "record", userId: "eval", siteId: "eval", mode: "normal", settings: {}, locale, topic, sourceType: "article_keyword", reviseCount: 0 } as unknown as ArticleRunRow;
  const search = createSearchClient(process.env, dataForSeo);
  if (search.name === "none") throw new Error("Set SEARXNG_URL or DataForSEO credentials: --record-brief needs a search adapter.");
  const ctx: StageContext = {
    run,
    attempt: 1,
    signal: new AbortController().signal,
    deps: { llm: createEngineLlm(endpoint), search, reader: createPageReader(process.env), dataForSeo, now: () => new Date(), stages: {} as never },
  };
  const r = MODE_PRESETS.normal.research;
  const result = await researchCore({ topic, sourceType: "article_keyword", locale, maxQueries: r.maxQueries, maxPages: r.maxPages, maxClaimsPerPage: r.maxClaimsPerPage, minVerifiedClaims: r.minVerifiedClaims }, ctx);
  const verified = result.rows.filter((x) => x.verified).length;
  if (verified < r.minVerifiedClaims) {
    throw new Error(`research found ${verified} verified claims (needs ${r.minVerifiedClaims}); ${result.sources.length} usable sources. Nothing written.`);
  }
  const id = nextBriefId(await readdir(EVALS_DIR), topic);
  const brief = briefFromResearch(id, topic, locale, result);
  const file = join(EVALS_DIR, `${id}.json`);
  await writeFile(file, `${JSON.stringify(brief, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote ${file}\n${brief.sources.length} sources, ${brief.evidence.length} verified claims (${result.rows.length} extracted).`);
  console.log("Review the claims and sources by hand, drop anything weak, then commit the file.");
}

function printReport(report: Awaited<ReturnType<typeof runEval>>) {
  console.log(`\nBaseline: ${report.baseline}   Judge: ${report.judgeModel}   Briefs: ${report.briefs.length}`);
  for (const mode of report.modes) {
    const s = report.summary[mode]!;
    const d = s.dimensions;
    console.log(`${mode.padEnd(7)} mean ${s.meanScore.toFixed(2)} (accuracy ${d.accuracy.toFixed(1)}, clarity ${d.clarity.toFixed(1)}, specificity ${d.specificity.toFixed(1)}, usefulness ${d.usefulness.toFixed(1)}, voice ${d.voice.toFixed(1)})  gates ${Math.round(s.gatePassRate * report.briefs.length)}/${report.briefs.length}  cost $${s.costUsd.toFixed(3)}${s.failures ? `  failures ${s.failures}` : ""}`);
    if (s.decision) console.log(`        ${s.decision.apply ? "clears the bar" : `below the bar: ${s.decision.reasons.join("; ")}`}`);
  }
  console.log(`Judge cost $${report.judgeCostUsd.toFixed(3)}`);
  for (const line of report.lines) console.log(line);
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", multiple: true },
      briefs: { type: "string" },
      "judge-model": { type: "string" },
      out: { type: "string" },
      "record-brief": { type: "string" },
      locale: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const modes = (values.mode?.length ? values.mode : ["fast", "normal"]) as string[];
  modes.forEach(parseEvalMode);
  const endpoint = engineAiEndpoint(process.env, process.env.OPENROUTER_API_KEY ?? null);
  if (!endpoint) throw new Error("No model endpoint: set OPENROUTER_API_KEY, or ENGINE_AI_BASE_URL with ENGINE_AI_API_KEY.");

  if (values["record-brief"]) return record(values["record-brief"], values.locale ?? "en", endpoint);

  const briefs = values.briefs ? await loadEvalBriefFiles(await matchFiles(values.briefs)) : await loadEvalBriefs();
  console.log(`Evaluating ${briefs.length} briefs in modes ${modes.join(", ")} (baseline ${modes[0]})...`);
  const report = await runEval(
    briefs,
    modes as EvalMode[],
    { llm: createEngineLlm(endpoint), chat: chatFor(endpoint), judgeModel: values["judge-model"] ?? MODE_PRESETS.deep.models.draft },
    { fastModel: MODE_PRESETS.normal.models.draft },
  );
  const out = resolve(values.out ?? join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  console.log(`Report: ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
