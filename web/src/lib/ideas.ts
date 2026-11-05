import type { StatusType } from "@/components/ui/status-badge";

export type IdeaStatus = "new" | "approved" | "scheduled" | "in_progress" | "drafted" | "rejected" | "archived";
export type IdeaMode = "normal" | "deep";
export interface IdeaScoreBreakdown {
  trend: number; fit: number; demand: number; feasibility: number; novelty: number; gain: number;
  keyword: { volume: number | null; difficulty: number | null; intent: string | null } | null;
  nearestPost: { id: string; title: string; similarity: number } | null;
  rationale: string;
}
export interface Idea {
  id: string; siteId: string; status: IdeaStatus; title: string; angle: string | null; primaryKeyword: string | null;
  alternateKeywords: string[]; searchIntent: string | null; audienceQuestion: string | null;
  /** Empty (`{}`) for an unscored manual idea. */
  brief: Partial<{ whyNow: string; outline: string[]; informationGain: string[]; sources: { url: string; title: string }[]; suggestedMode: IdeaMode }>;
  score: number | null; scoreBreakdown: IdeaScoreBreakdown | null;
  origin: "discovered" | "manual" | "refresh"; discoveryId: string | null; mode: IdeaMode;
  scheduledFor: string | null; jobId: string | null; postId: string | null; rejectedReason: string | null; error: string | null;
  createdAt: string; updatedAt: string;
}
export interface IdeaDiscovery {
  id: string; siteId: string; status: "queued" | "running" | "done" | "failed"; signalCount: number | null; ideaCount: number | null;
  costUsd: number | null; error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string;
}
export interface CalendarSlot {
  at: string; localDate: string; isCadenceSlot: boolean;
  idea: { id: string; title: string; status: IdeaStatus; score: number | null; mode: IdeaMode; jobId: string | null; error: string | null } | null;
  post: { id: string; title: string; status: string } | null;
}
export interface IdeaSettings {
  cadence: { weekdays: number[]; time: string; timezone: string };
  leadDays: number; defaultMode: IdeaMode;
  autopilot: { enabled: boolean; approvePerWeek: number; minScore: number };
  weights: { trend: number; fit: number; demand: number; feasibility: number; novelty: number; gain: number };
  seedTopics: string[]; competitors: string[];
  learnWeights: boolean; weightsLearnedMonth: string | null;
  weightHistory: { month: string; samples: number; weights: IdeaSettings["weights"] }[];
}

export const FACTORS = [
  ["trend", "Trend", "how much it's in the news now"],
  ["fit", "Fit", "how well it matches your site"],
  ["demand", "Search demand", "people are searching for it"],
  ["feasibility", "Feasibility", "can we rank for it"],
  ["novelty", "Novelty", "not already covered"],
  ["gain", "Information gain", "adds something new"],
] as const;

export const STATUS_BADGE: Record<IdeaStatus, { status: StatusType; label: string }> = {
  new: { status: "pending", label: "New" },
  approved: { status: "active", label: "Approved" },
  scheduled: { status: "active", label: "Scheduled" },
  in_progress: { status: "running", label: "Writing" },
  drafted: { status: "success", label: "Drafted" },
  rejected: { status: "paused", label: "Rejected" },
  archived: { status: "draft", label: "Archived" },
};

export const ideasKey = (siteId: string | undefined, ...rest: unknown[]) => ["ideas", siteId, ...rest];
export const formatSlot = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
