import { activeLocales, getLocalization, type LocaleSetting } from "../../../services/localization/settings.js";
import { localizeArticle } from "../../../services/localization/localize.js";
import { promptVersion } from "../../prompts/load.js";
import { componentProfile, type ComponentProfile } from "../../profile.js";
import type { Stage } from "../../runtime/stage.js";
import { truncate } from "../../util.js";
import type { BriefOutput } from "../brief/schema.js";
import type { DraftOutput } from "../draft/schema.js";
import { latestDraft, latestStageOutput, renderArticle, runSettings } from "../shared.js";
import type { LocalizedLocale, LocalizeOutput } from "./schema.js";

export type LocalizeInput = {
  draft: DraftOutput;
  keyword: string;
  locales: LocaleSetting[];
  profile: ComponentProfile;
  /** What the run budget has left, in USD; localization spends no more than this. */
  remainingUsd: number;
};

const ERROR_MAX = 200;
/** A locale is started only with this much of the stage lease left: an aborted stage is retried and, after three, fails the run and its English draft. */
const LOCALE_MIN_MS = 10 * 60_000;

/**
 * After the English article passed its checks and before delivery: translates it into each of the site's enabled locales.
 * A failure never fails the run: a locale that cannot be translated is recorded with its error, and the run goes on to
 * deliver the English draft. Deliver stores the translations against the post it creates.
 */
export const localizeStage: Stage<LocalizeInput, LocalizeOutput> = {
  key: "localize",
  promptVersion: await promptVersion("localize", "localize-review", "localize-keyword"),
  async input({ run }) {
    const [draft, brief, settings] = await Promise.all([latestDraft(run), latestStageOutput<BriefOutput>(run, "brief"), getLocalization(run.userId, run.siteId)]);
    return { draft, keyword: brief.primaryKeyword, locales: activeLocales(settings), profile: componentProfile(run), remainingUsd: run.budgetUsd - run.spentUsd };
  },
  async run(input, ctx) {
    const { run } = ctx;
    const { markdown } = await renderArticle(run, input.draft.markdown);
    const models = runSettings(run).models;
    const locales: LocalizedLocale[] = [];
    let spent = 0;
    for (const locale of input.locales) {
      const left = input.remainingUsd - spent;
      const outOfTime = !!run.leaseExpiresAt && run.leaseExpiresAt.getTime() - ctx.deps.now().getTime() < LOCALE_MIN_MS;
      if (left <= 0 || outOfTime) {
        const error = left <= 0 ? "The run budget is spent" : "No time left in this run; translate it from the post editor";
        locales.push({ locale: locale.locale, status: "failed", title: "", slug: "", description: "", content: "", imageAlt: "", keyword: null, findings: [], costUsd: 0, error });
        continue;
      }
      try {
        const r = await localizeArticle({
          userId: run.userId,
          siteId: run.siteId,
          locale,
          source: { title: input.draft.title, description: input.draft.description, markdown, imageAlt: "", keyword: input.keyword },
          deps: { llm: ctx.deps.llm, dataForSeo: ctx.deps.dataForSeo, models: { localize: models.localize, review: models.localize_review }, profile: input.profile, origin: "system", logSpend: false, signal: ctx.signal, maxCostUsd: left },
        });
        spent += r.costUsd;
        locales.push({ locale: locale.locale, status: r.status, ...r.translation, findings: r.findings, costUsd: r.costUsd });
      } catch (error) {
        // An aborted attempt (the lease ran out) is retried by the runtime; anything else is recorded and the English still ships.
        if (ctx.signal.aborted) throw error;
        // `localizeArticle` attaches what it spent before failing; the next locale's budget must count it.
        const cost = Number((error as { costUsd?: unknown } | null)?.costUsd) || 0;
        spent += cost;
        locales.push({
          locale: locale.locale, status: "failed", title: "", slug: "", description: "", content: "", imageAlt: "", keyword: null, findings: [], costUsd: cost,
          error: truncate(error instanceof Error ? error.message : "Localization failed", ERROR_MAX),
        });
      }
    }
    const usage = spent > 0 ? [{ model: models.localize, promptTokens: 0, completionTokens: 0, costUsd: spent }] : [];
    return { next: { type: "advance", to: "deliver" }, output: { locales }, usage };
  },
};
