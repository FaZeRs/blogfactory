import { db } from "../../db/index.js";
import { generationLogs } from "../../db/schema.js";
import type { EngineLlm } from "../../engine/adapters/llm.js";
import type { DataForSeoClient } from "../../engine/adapters/types.js";
import { ENGINE_CONFIG } from "../../engine/config.js";
import { type GateResult, gateBlockers, gateResult } from "../../engine/gates/types.js";
import { withSiteVoice } from "../../engine/gates/voice.js";
import type { ComponentProfile } from "../../engine/profile.js";
import { DATA_RULE, fenceData, preparePrompt } from "../../engine/prompts/load.js";
import { normalizeDraftMarkdown } from "../../engine/stages/shared.js";
import { sanitizeText } from "../../engine/util.js";
import { billedModel } from "../engine-llm.js";
import { finishOperationEvent, startOperationEvent } from "../operation-events.js";
import { getEffectiveSettings } from "../user-settings.js";
import { type Finding, asciiSlug, toFindings, translationChecks } from "./checks.js";
import { chooseKeyword, glossaryText } from "./keyword.js";
import { localizeBlogLinks, translatedSlugs } from "./links.js";
import { patchTranslation } from "./patch.js";
import { type Review, ReviewSchema, type Translated, TranslationSchema } from "./schema.js";
import { type LocaleSetting, getLocalization } from "./settings.js";

const MAX_OUTPUT_TOKENS = 16_000;
const MAX_REVISIONS = 2;
const FIRST_ATTEMPT = "None. This is the first attempt.";
const NONE = "None.";
const REVIEW_GATE = "review";
const NATURALNESS_GATE = "naturalness";
const REPEAT_GATE = "repeat";

export class LocaleNotConfiguredError extends Error {
  constructor(locale: string) {
    super(`Localization is not enabled for "${locale}" on this site`);
    this.name = "LocaleNotConfiguredError";
  }
}

export type LocalizeSource = { title: string; description: string; markdown: string; imageAlt: string; keyword?: string | null };
/** An existing translation to update. `edited` is a hand-edited one: minor polish never rewrites its wording. */
export type ExistingTranslation = { title: string; slug: string; description: string; content: string; imageAlt: string; edited?: boolean };

export type LocalizeDeps = {
  llm: EngineLlm;
  dataForSeo: DataForSeoClient | null;
  /** Resolved model ids for the two roles. */
  models: { localize: string; review: string };
  profile: ComponentProfile;
  /** `system` inside an engine run, `web` for an owner's request. */
  origin: "web" | "system";
  /** False inside an engine run: the run books its own spend, so booking it here too would count it twice. */
  logSpend: boolean;
  signal?: AbortSignal;
  /** No new model call starts once this much has been spent; what exists is kept. */
  maxCostUsd?: number;
};

export type LocalizeResult = {
  status: "ready" | "needs_review";
  translation: { title: string; slug: string; description: string; content: string; imageAlt: string; keyword: string | null };
  findings: Finding[];
  costUsd: number;
  revisions: number;
  patched: number;
};

type Checked = { results: GateResult[]; blockers: ReturnType<typeof gateBlockers>; review: Review | null };

const clean = (text: string) => sanitizeText(text).normalize("NFC");
const articleText = (t: { title: string; description: string; markdown: string }) => `Title: ${t.title}\nDescription: ${t.description}\n\n${t.markdown}`;
const attemptText = (t: Translated) => `Title: ${t.title}\nDescription: ${t.description}\nSlug: ${t.slug}\nCover image alt text: ${t.imageAlt}\n\n${t.markdown}`;

/** The model's translation, cleaned; the slug is mapped to ASCII. */
const normalize = (raw: Translated): Translated => ({
  title: clean(raw.title).trim(),
  description: clean(raw.description).trim(),
  markdown: normalizeDraftMarkdown(clean(raw.markdown)),
  slug: asciiSlug(clean(raw.slug)),
  imageAlt: clean(raw.imageAlt).trim(),
});

const addressRule = (l: LocaleSetting) =>
  l.formalAddress?.forbidden.length
    ? `Use the formal form of address. These informal forms must never appear: ${l.formalAddress.forbidden.join(", ")}.`
    : "Follow the style guide for the form of address.";

const problemsText = (rows: { gate: string; message: string; excerpt?: string; fix?: string }[]) =>
  rows.map((b) => `- [${b.gate}] ${sanitizeText(b.message)}${b.excerpt ? `\n    text: "${sanitizeText(b.excerpt)}"` : ""}${b.fix ? `\n    hint: ${sanitizeText(b.fix)}` : ""}`).join("\n");

/**
 * The paragraphs that were added or removed between two English versions, for the translator to update by. Pure.
 * A paragraph is a block between blank lines; a reworded paragraph shows as one removed and one added.
 */
export function summarizeChange(before: string, after: string): string {
  const blocks = (md: string) => md.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const a = blocks(before);
  const b = blocks(after);
  const inA = new Set(a);
  const inB = new Set(b);
  const cut = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t);
  const lines = [
    ...a.filter((x) => !inB.has(x)).slice(0, 25).map((x) => `- removed or reworded (old): ${cut(x)}`),
    ...b.filter((x) => !inA.has(x)).slice(0, 25).map((x) => `+ added or reworded (new): ${cut(x)}`),
  ];
  return lines.length ? lines.join("\n") : "No paragraph changed; only the title or description may differ.";
}

async function resolveLocale(userId: string, siteId: string, locale: string | LocaleSetting): Promise<LocaleSetting> {
  if (typeof locale !== "string") return locale;
  const settings = await getLocalization(userId, siteId);
  const found = settings.enabled ? settings.locales.find((l) => l.locale === locale) : undefined;
  if (!found) throw new LocaleNotConfiguredError(locale);
  return found;
}

/**
 * Translates one article: the target keyword, then the translation, the code checks and the native-editor review, the
 * reviewer's exact fixes applied in code and re-checked (not counted as a revision), then up to 2 revisions that edit the
 * failed attempt. The last attempt without blockers is kept, so a later failed polish never replaces it. A text that never
 * passes comes back as `needs_review` with its findings. The caller stores it; nothing here writes a translation row.
 * Every query is scoped to `userId` and `siteId`. Spend is booked to `generation_logs` unless `deps.logSpend` is false.
 */
export async function localizeArticle(args: {
  userId: string;
  siteId: string;
  /** The code of a locale enabled for the site, or its settings (the engine stage loads them once). */
  locale: string | LocaleSetting;
  source: LocalizeSource;
  /** The existing translation: update mode. */
  base?: ExistingTranslation;
  /** What changed in the English since `base` was made (`summarizeChange`). */
  changes?: string;
  /** The post being translated; its own slug is not offered as a link target. */
  postId?: string;
  /** A person's corrections to `base`: the first pass edits it to apply them and changes nothing else. */
  requests?: string;
  deps: LocalizeDeps;
}): Promise<LocalizeResult> {
  const { userId, siteId, source, base, deps } = args;
  const locale = await resolveLocale(userId, siteId, args.locale);
  const settings = await getEffectiveSettings(userId, siteId);
  const voice = withSiteVoice(ENGINE_CONFIG.voice, settings.contentRules);
  const gates = ENGINE_CONFIG.gates;
  const started = Date.now();
  const eventId = await startOperationEvent({ userId, siteId, origin: deps.origin, action: "posts.localize", objectType: args.postId ? "post" : null, objectId: args.postId ?? null });

  let spent = 0;
  const llm: EngineLlm = {
    async json(req) {
      try {
        const r = await deps.llm.json(req);
        spent += r.costUsd;
        return r;
      } catch (error) {
        // A failed call can still have cost money (a bad reply twice, a late 429).
        spent += Number((error as { costUsd?: unknown } | null)?.costUsd) || 0;
        throw error;
      }
    },
  };
  const overBudget = () => deps.maxCostUsd !== undefined && spent >= deps.maxCostUsd;
  let revisions = 0;
  let patchedTotal = 0;
  let result: LocalizeResult | null = null;
  try {
    const glossary = glossaryText(locale);
    const styleGuide = locale.styleGuide.trim() || "None: write natural, professional prose.";
    const keyword = await chooseKeyword({ llm, model: deps.models.review, dataForSeo: deps.dataForSeo, locale, en: { keyword: source.keyword ?? "", title: source.title }, signal: deps.signal });
    const keywordInstruction = keyword
      ? `Use this ${locale.name} primary keyword, with its diacritics, in the title and in the description, and its main words in the slug (ASCII, no diacritics). Inflect it only where the grammar requires. The keyword:\n${fenceData("target-keyword", keyword.keyword)}`
      : "None for this article.";
    const slugs = await translatedSlugs(userId, siteId, locale.locale, args.postId);
    const baseFenced = base ? fenceData("existing-translation", articleText({ title: base.title, description: base.description, markdown: base.content }) + `\nSlug: ${base.slug}\nCover image alt text: ${base.imageAlt}`) : NONE;
    // Minor polish never rewrites wording a person left in an edited translation; a major finding still may.
    const protectedText = base?.edited ? articleText({ title: base.title, description: base.description, markdown: base.content }) : null;
    const polishable = (excerpt = "") => !protectedText?.includes(excerpt.trim());

    const translate = async (feedback: string, current: Translated | null): Promise<Translated> => {
      const prompt = await preparePrompt("localize", {
        dataRule: DATA_RULE,
        localeName: locale.name,
        localeCode: locale.locale,
        styleGuide,
        glossary,
        addressRule: addressRule(locale),
        titleMax: gates.titleMax,
        descriptionMax: gates.descriptionMax,
        title: fenceData("title", source.title),
        description: fenceData("description", source.description || NONE),
        imageAlt: fenceData("image-alt", source.imageAlt || NONE),
        en: fenceData("article", source.markdown),
        base: baseFenced,
        changes: base && args.changes ? fenceData("changes", args.changes) : NONE,
        keyword: keywordInstruction,
        current: current ? fenceData("attempt", attemptText(current)) : FIRST_ATTEMPT,
        feedback: feedback === FIRST_ATTEMPT ? FIRST_ATTEMPT : fenceData("problems", feedback),
      });
      const r = await llm.json({ role: "localize", model: deps.models.localize, system: prompt.system, user: prompt.user, schema: TranslationSchema, maxTokens: MAX_OUTPUT_TOKENS, signal: deps.signal });
      const tr = normalize(r.value);
      return { ...tr, markdown: localizeBlogLinks(tr.markdown, slugs, locale.locale) };
    };

    const check = async (tr: Translated): Promise<Checked> => {
      const results: GateResult[] = translationChecks({
        en: { title: source.title, description: source.description, markdown: source.markdown },
        tr, locale, profile: deps.profile, gates, voice,
      });
      let review: Review | null = null;
      if (overBudget()) {
        results.push(gateResult(REVIEW_GATE, [{ message: "the language review was skipped: the budget for this step is spent" }]));
      } else {
        try {
          const prompt = await preparePrompt("localize-review", {
            dataRule: DATA_RULE,
            localeName: locale.name,
            addressRule: addressRule(locale),
            styleGuide,
            glossary,
            en: fenceData("original", articleText(source)),
            tr: fenceData("translation", articleText(tr)),
          });
          review = (await llm.json({ role: "localize_review", model: deps.models.review, system: prompt.system, user: prompt.user, schema: ReviewSchema, maxTokens: 8000, signal: deps.signal })).value;
        } catch (error) {
          if (deps.signal?.aborted) throw error;
          results.push(gateResult(REVIEW_GATE, [{ message: "the language review could not run" }]));
        }
      }
      if (review) {
        const issues = (severity: "major" | "minor") => review!.issues.filter((i) => i.severity === severity)
          .map((i) => ({ excerpt: i.excerpt, hint: i.fix, message: `[${i.field ?? "markdown"}] ${i.problem}` }));
        results.push(gateResult(REVIEW_GATE, issues("major"), "blocker", { fluency: review.fluency }), gateResult(NATURALNESS_GATE, issues("minor"), "warning"));
      }
      return { results, blockers: gateBlockers(results), review };
    };

    let passing: { checked: Checked; tr: Translated } | null = null;
    const settle = (checked: Checked, tr: Translated) => {
      // No blockers implies a review: a skipped or failed one is itself a blocker.
      if (checked.blockers.length === 0) passing = { checked, tr };
      return { checked, tr };
    };
    // The review's own exact corrections, applied in code, then every check again: one review call, no translation.
    const patchRound = async (tr: Translated, checked: Checked) => {
      settle(checked, tr);
      const fixes = (checked.review?.issues ?? [])
        .filter((i) => i.severity === "major" || polishable(i.excerpt))
        .sort((a, b) => Number(a.severity === "minor") - Number(b.severity === "minor"));
      const patch = patchTranslation(tr, fixes);
      if (!patch) return { checked, tr };
      patchedTotal += patch.patched;
      return settle(await check(patch.text), patch.text);
    };
    const failedOf = (c: Checked, gate: string) =>
      gateBlockers(c.results.filter((r) => r.gate === gate && !r.passed).map((r) => ({ ...r, severity: "blocker" as const })));
    const naturalness = (c: Checked) => failedOf(c, NATURALNESS_GATE).filter((b) => polishable(b.excerpt));

    const requested = base && args.requests?.trim()
      ? `The site owner's corrections to the existing translation. Apply every one exactly, keep everything else as it is, and apply a general rule (for example a term or a form of address) everywhere it occurs:\n${args.requests.trim()}`
      : null;
    const first = await translate(requested ?? FIRST_ATTEMPT, null);
    let { checked, tr } = await patchRound(first, await check(first));
    let revisionFailed = false;
    while (
      (checked.blockers.length > 0 || naturalness(checked).length > 0 || (revisions === 0 && failedOf(checked, REPEAT_GATE).length > 0)) &&
      revisions < MAX_REVISIONS && !overBudget()
    ) {
      revisions += 1;
      try {
        // The revision edits the attempt that just failed: fix exactly these problems, change nothing else.
        const revised = await translate(problemsText([...checked.blockers, ...failedOf(checked, REPEAT_GATE), ...naturalness(checked)]), tr);
        ({ checked, tr } = await patchRound(revised, await check(revised)));
      } catch (error) {
        // A failed revision must not cost the translation that already exists.
        if (deps.signal?.aborted) throw error;
        revisionFailed = true;
        break;
      }
    }
    ({ checked, tr } = (passing as { checked: Checked; tr: Translated } | null) ?? { checked, tr });
    result = {
      status: checked.blockers.length === 0 ? "ready" : "needs_review",
      translation: { title: tr.title, slug: tr.slug, description: tr.description, content: tr.markdown, imageAlt: tr.imageAlt, keyword: keyword?.keyword ?? null },
      findings: [...toFindings(checked.results), ...(revisionFailed ? [{ gate: "revision", severity: "warning" as const, message: "a revision of this translation could not be completed" }] : [])],
      costUsd: spent,
      revisions,
      patched: patchedTotal,
    };
    return result;
  } finally {
    const findings = result?.findings ?? [];
    await finishOperationEvent({
      id: eventId,
      status: result ? "succeeded" : "failed",
      durationMs: Date.now() - started,
      ...(result ? {} : { errorCode: "localize_failed" }),
      metadata: {
        locale: locale.locale,
        mode: base && args.requests?.trim() ? "requests" : base ? "update" : "new",
        status: result?.status ?? "failed",
        revisions,
        patched: patchedTotal,
        blockers: findings.filter((f) => f.severity === "blocker").length,
        warnings: findings.filter((f) => f.severity === "warning").length,
        cost_usd: Math.round(spent * 1e6) / 1e6,
      },
    }).catch(() => {});
    if (deps.logSpend && spent > 0) {
      const model = billedModel(deps.models.localize);
      await db.insert(generationLogs).values({
        userId, postId: args.postId ?? null, usageType: "text", modelId: model, provider: model.split("/")[0] ?? null,
        status: result ? "success" : "failed", cost: spent, responseData: { localize: { locale: locale.locale, siteId } },
      }).catch(() => console.error("[localize] Could not log spend"));
    }
  }
}
