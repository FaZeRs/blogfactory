import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type VisibilitySettings = {
  enabled: boolean;
  questions: string[];
  engines: string[];
  /** 0 Sunday ... 6 Saturday. */
  weekday: number;
  monthlyCapUsd: number;
  brandTerms: string[];
};

export type VisibilityCheck = {
  question: string;
  engine: string;
  engineLabel: string;
  status: string;
  error?: string | null;
  answer?: string | null;
  cited: boolean;
  citedUrls: string[];
  mentioned: boolean;
  otherHosts: string[];
  competitorHosts: string[];
};

export type VisibilitySummary = {
  week: string | null;
  latest: {
    questions: number;
    answered: number;
    citedQuestions: number;
    share: number;
    mentionedShare: number;
    engines: { engine: string; label: string; asked: number; cited: number; share: number }[];
  };
  trend: { week: string; share: number; answered: number }[];
  topCompetitors: { host: string; count: number; flagged: boolean }[];
  gaps: { question: string; competitorHosts: string[]; otherHosts: string[]; twoWeeks: boolean }[];
  checks: VisibilityCheck[];
  costThisMonth: number;
};

export type AiVisibilityState = {
  available: boolean;
  reason?: "no_openrouter_key" | "custom_gateway";
  settings: VisibilitySettings;
  summary: VisibilitySummary;
  running: boolean;
};

export const aiVisibilityKey = (siteId?: string) => ["ai-visibility", siteId] as const;

/** Polls every 5 s while a check runs. */
export const useAiVisibility = (siteId?: string) => useQuery({
  queryKey: aiVisibilityKey(siteId),
  queryFn: () => api.get<AiVisibilityState>(`/ai-visibility?siteId=${siteId}`),
  enabled: Boolean(siteId),
  refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
});
