export interface EngineConfig {
  evidence: {
    minQuoteWords: number;
    maxQuoteWords: number;
    /** Fraction of a quote's words that must match the source. */
    minRatio: number;
    maxSourceAgeDays: number;
    /** Slack on the quote search window, as a fraction of the quote length. */
    windowSlack: number;
  };
  gates: {
    minWords: number;
    maxWords: number;
    targetWords: number;
    titleMax: number;
    descriptionMax: number;
    faqAnswerMin: number;
    /** 8-word-gram overlap with sources, in percent of the article. */
    overlapMaxPercent: number;
    /** Lexical similarity to an existing post (shingle Jaccard). */
    similarityMax: number;
  };
  /**
   * `bannedPhrases` block the voice gate anywhere in the text; `bannedWords` block as whole words; `warnPhrases` warn,
   * and match their inflections. The gates stage adds the site's own voice rules to these.
   */
  voice: { bannedPhrases: readonly string[]; bannedWords?: readonly string[]; warnPhrases: readonly string[] };
}

export const ENGINE_CONFIG: EngineConfig = {
  evidence: {
    maxQuoteWords: 60,
    maxSourceAgeDays: 30,
    minQuoteWords: 8,
    minRatio: 0.92,
    windowSlack: 0.1,
  },
  gates: {
    descriptionMax: 155,
    faqAnswerMin: 40,
    maxWords: 2400,
    minWords: 1400,
    overlapMaxPercent: 5,
    similarityMax: 0.5,
    targetWords: 2200,
    titleMax: 60,
  },
  // Lindevo's banned list is hospitality positioning, so it is empty here.
  voice: {
    bannedPhrases: [],
    warnPhrases: ["seamless", "leverag", "ai agent"],
  },
};
