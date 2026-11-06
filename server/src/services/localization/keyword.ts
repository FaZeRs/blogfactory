import { localeMarket } from "../../engine/adapters/dataforseo.js";
import type { EngineLlm } from "../../engine/adapters/llm.js";
import type { DataForSeoClient } from "../../engine/adapters/types.js";
import { DATA_RULE, fenceData, preparePrompt } from "../../engine/prompts/load.js";
import { sanitizeText } from "../../engine/util.js";
import { KeywordCandidatesSchema } from "./schema.js";
import type { LocaleSetting } from "./settings.js";

export type KeywordCandidate = { keyword: string; volume: number | null };
export type KeywordChoice = KeywordCandidate;

const USED = 3;

/** The highest volume wins (ties keep the model's order); all zero or unknown picks the model's first choice. */
export function pickKeyword(candidates: readonly KeywordCandidate[]): KeywordCandidate | null {
  let best: KeywordCandidate | null = null;
  for (const c of candidates) if ((c.volume ?? 0) > (best?.volume ?? 0)) best = c;
  return best ?? candidates[0] ?? null;
}

export const glossaryText = (locale: LocaleSetting) =>
  locale.glossary.length ? locale.glossary.map((g) => `- ${g.source} → ${g.target}${g.note ? ` (${g.note})` : ""}`).join("\n") : "None.";

/** Search data exists for the markets `localeMarket` knows; any other language would be measured in the wrong market. */
export const keywordMarketKnown = (locale: string) => {
  const language = locale.split("-")[0]!;
  return localeMarket(language).languageCode === language;
};

/**
 * With search data: one model call proposes how people in the target language would type the English keyword, code looks up
 * the volume of each in the locale's market, and the highest wins. The keyword is an extra, so anything that fails
 * (no search data, an unsupported market, a bad reply, a lookup error) skips it with no error. Only an aborted run throws.
 */
export async function chooseKeyword(input: {
  llm: EngineLlm;
  model: string;
  dataForSeo: DataForSeoClient | null;
  locale: LocaleSetting;
  en: { keyword: string; title: string };
  signal?: AbortSignal;
}): Promise<KeywordChoice | null> {
  const { llm, dataForSeo, locale, en, signal } = input;
  if (!dataForSeo || !en.keyword.trim() || !keywordMarketKnown(locale.locale)) return null;
  try {
    const prompt = await preparePrompt("localize-keyword", {
      dataRule: DATA_RULE,
      localeName: locale.name,
      glossary: glossaryText(locale),
      keyword: fenceData("keyword", en.keyword),
      title: fenceData("title", en.title),
    });
    const reply = await llm.json({ role: "localize_review", model: input.model, system: prompt.system, user: prompt.user, schema: KeywordCandidatesSchema, maxTokens: 1000, signal });
    const seen = new Set<string>();
    const proposed = reply.value.candidates
      .map((c) => sanitizeText(c).normalize("NFC").trim())
      .filter((c) => c && !seen.has(c.toLowerCase()) && !!seen.add(c.toLowerCase()))
      .slice(0, USED);
    const scored: KeywordCandidate[] = [];
    for (const keyword of proposed) {
      const overview = await dataForSeo.keywordOverview(keyword, { locale: locale.locale.split("-")[0]!, signal }).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      });
      scored.push({ keyword, volume: overview?.volume ?? null });
    }
    return pickKeyword(scored);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
