// Shared harness for the DB-backed stage tests: a real `advanceArticleRun` over fakes (no network).
// Only import this after checking `dbTestsEnabled()`; it opens the database.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { articleRuns, articleStageRuns, jobs, sites, users } from "../../db/schema.js";
import { createFakeLlm } from "../adapters/fake-llm.js";
import { createFakeReader, createFakeSearch } from "../adapters/fakes.js";
import type { DataForSeoClient, KeywordOverview } from "../adapters/types.js";
import { claimArticleRuns } from "../runtime/claim.js";
import { advanceArticleRun } from "../runtime/advance.js";
import type { EngineDeps } from "../runtime/deps.js";
import type { ArticleRunRow } from "../runtime/stage.js";
import { STAGES } from "./index.js";

export function dbTestsEnabled(name: string): boolean {
  if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
    console.log(`${name} skipped: set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with DATABASE_URL pointing at a disposable database`);
    return false;
  }
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  return true;
}

const userIds: string[] = [];
export const cleanup = async () => {
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
};

export async function fixture(mode: "normal" | "deep") {
  const [user] = await db.insert(users).values({ email: `engine-${randomUUID()}@example.test`, passwordHash: "x" }).returning();
  userIds.push(user!.id);
  const [site] = await db.insert(sites).values({ userId: user!.id, name: "t", domain: "t.example.test" }).returning();
  const [job] = await db.insert(jobs).values({
    userId: user!.id, siteId: site!.id, sourceType: "article_keyword", sourceValue: "solar for small teams", modelId: "m", status: "processing",
  }).returning();
  const [run] = await db.insert(articleRuns).values({
    userId: user!.id, siteId: site!.id, jobId: job!.id, mode, sourceType: "article_keyword", topic: "solar for small teams",
    settings: {}, budgetUsd: mode === "deep" ? 5 : 1, nextAttemptAt: new Date(Date.now() - 1000),
  }).returning();
  return { user: user!, site: site!, job: job!, run: run! };
}

export const reloadRun = async (id: string): Promise<ArticleRunRow> => (await db.select().from(articleRuns).where(eq(articleRuns.id, id)))[0]!;

// Three pages with one checkable sentence each; claims are matched to the page by their quote.
const QUOTES = [
  "Small teams that review their energy bills every month usually find the largest savings in the first quarter of tracking",
  "Installers recommend measuring the roof shading across a whole year before choosing the size of a rooftop solar system",
  "A battery only pays off when the household uses most of the stored power in the evening rather than selling it back",
];
const page = (i: number) => ({
  title: `Report ${i + 1}`,
  markdown: `# Report ${i + 1}\n\n${QUOTES[i]}.\n\n${"Background paragraph about regional energy markets, tariffs and metering rules. ".repeat(12)}`,
  fetchedAt: new Date(),
});
const URLS = [1, 2, 3].map((i) => `https://source${i}.example/report`);

const sentence = (n: number, i: number) =>
  `Item ${n}${i} describes a plain step that a small team can plan, test and repeat each week without buying anything new.`;
const para = (n: number) => Array.from({ length: 5 }, (_, i) => sentence(n, i)).join(" ");
const FAQ = [
  "## Frequently Asked Questions",
  "### How often should a team review its energy use?",
  "A short monthly review is enough for most teams, and it keeps the numbers fresh for the next decision.",
  "### Is a battery worth the cost for a small office?",
  "It depends on how much stored power the office uses in the evening, so measure that before buying anything.",
  "### Who should check the roof before an installation?",
  "Ask a qualified installer to measure shading across the year and to confirm the roof can carry the load.",
].join("\n\n");

/** About 1,600 words: passes every code gate. */
export const GOOD_ARTICLE = [
  `${para(1)} Teams that track their bills find savings early {{c:c1}}.`,
  para(2),
  "- Review the bills every month.\n- Measure the roof shading first.\n- Size the battery to the evening load.",
  ...[3, 4, 5, 6, 7].flatMap((n) => [`## Section number ${n}`, `${para(n)} The shading advice matters here {{c:c2}}.`, `${para(n + 10)} Evening use decides the battery {{c:c3}}.`]),
  FAQ,
].join("\n\n");

/** Over 2,000 characters but far under the word minimum, so only the meta gate fails. */
export const SHORT_ARTICLE = [
  `${para(1)} ${para(2)} ${para(3)} ${para(4)} Teams that track their bills find savings early {{c:c1}}{{c:c2}}{{c:c3}}.`,
  FAQ,
].join("\n\n");

const draftReply = (markdown: string) => ({
  title: "Solar for small teams, explained",
  description: "A calm, practical guide to planning rooftop solar and storage for a small team.",
  markdown,
  citedClaimIds: ["c1", "c2", "c3"],
});

const BRIEF = {
  angle: "A calm plan for small teams that want solar without surprises",
  primaryKeyword: "solar for small teams",
  titleOptions: ["Solar for small teams, explained", "Solar planning for small offices", "A small team guide to solar"],
  chosenTitle: "Solar for small teams, explained",
  description: "A calm, practical guide to planning rooftop solar and storage for a small team.",
  outline: [3, 4, 5, 6, 7].map((n) => ({
    heading: `Section number ${n}`,
    purpose: "Explain one step of the plan in plain words",
    claimIds: [`c${((n - 3) % 3) + 1}`],
    words: 300,
  })),
  faq: [
    { question: "How often should a team review its energy use?", answerPoints: ["monthly"] },
    { question: "Is a battery worth the cost for a small office?", answerPoints: ["evening use"] },
    { question: "Who should check the roof before an installation?", answerPoints: ["installer"] },
  ],
  takeaways: ["Review the bills every month.", "Measure the roof shading first.", "Size the battery to the evening load."],
  internalLinks: [],
};

const SERP_ANALYSIS = {
  searchIntent: "Planning rooftop solar for a small team",
  coveredTopics: ["Costs", "Roof shading"],
  gaps: ["How to size a battery to the evening load"],
  informationGain: [{ point: "Battery sizing follows evening use, not roof size", claimIds: ["c3", "c99"] }],
};

export type Script = { drafts: string[]; revisions: string[] };

export function makeDeps(script: Script) {
  const base = createFakeLlm({
    research_queries: [{ queries: ["solar for small teams", "solar roof shading advice"] }],
    brief: [BRIEF],
    draft: script.drafts.map(draftReply),
    revise: script.revisions.map(draftReply),
  });
  // Claim extraction is matched to its page, because pages are read in parallel.
  const llm: typeof base = {
    ...base,
    json: (req) => {
      if (req.role === "research_claims" && req.user.includes("## Ranking pages")) {
        return createFakeLlm({ research_claims: [SERP_ANALYSIS] }).json(req);
      }
      if (req.role !== "research_claims") return base.json(req);
      const i = QUOTES.findIndex((q) => req.user.includes(q));
      const claim = ["Teams that review bills monthly find savings early.", "Roof shading should be measured across a full year.", "A battery pays off with high evening use."][i]!;
      return createFakeLlm({ research_claims: [{ claims: [{ claim, kind: "fact", quote: QUOTES[i] }] }] }).json(req);
    },
  };
  const keywordCalls = { n: 0 };
  const dataForSeo: DataForSeoClient = {
    serp: async () => [],
    keywordOverview: async (keyword): Promise<KeywordOverview> => {
      keywordCalls.n += 1;
      return { keyword, volume: 100, difficulty: 10, intent: "informational", aiOverview: false };
    },
    peopleAlsoAsk: async () => [],
  };
  const deps: EngineDeps = {
    llm,
    search: createFakeSearch({ "solar for small teams": URLS.map((url, i) => ({ url, title: `Report ${i + 1}`, snippet: "" })) }),
    reader: createFakeReader(Object.fromEntries(URLS.map((u, i) => [u, page(i)]))),
    dataForSeo,
    now: () => new Date(),
    stages: STAGES,
  };
  return { deps, llm: base, keywordCalls };
}

const TERMINAL = ["done", "failed", "escalated"];

/** Claims and advances the run until it ends, or until it is about to run `until`. */
export async function drive(runId: string, deps: EngineDeps, until?: string): Promise<ArticleRunRow> {
  for (let i = 0; i < 30; i += 1) {
    const current = await reloadRun(runId);
    if (TERMINAL.includes(current.state) || (until && current.currentStage === until)) return current;
    const claimed = await claimArticleRuns("w-engine-test", 50, new Date(Date.now() + 60_000));
    const mine = claimed.find((r) => r.id === runId);
    if (mine) await advanceArticleRun(mine, deps);
  }
  const rows = await db.select().from(articleStageRuns).where(eq(articleStageRuns.runId, runId));
  throw new Error(`run did not finish: ${rows.map((r) => `${r.stage}#${r.attempt} ${r.status} ${r.error ?? ""}`).join(" | ")}`);
}
