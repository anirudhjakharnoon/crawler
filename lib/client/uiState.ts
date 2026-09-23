import type { ProbeResult } from "@/lib/crawl/probe";
import type { CrawlJobRow } from "@/lib/supabase/types";

export type UiState =
  | "idle"
  | "probing"
  | "invalid"
  | "robots-blocked"
  | "running"
  | "capped"
  | "completed"
  | "partial"
  | "aborted";

export const STATE_LABELS: Record<UiState, string> = {
  idle: "IDLE",
  probing: "PROBING",
  invalid: "INVALID TARGET",
  "robots-blocked": "ROBOTS-BLOCKED",
  running: "RUNNING",
  capped: "CAPPED",
  completed: "COMPLETED",
  partial: "PARTIAL / ERROR",
  aborted: "ABORTED",
};

export function deriveUiState(params: {
  job: CrawlJobRow | null;
  probing: boolean;
  probeResult: ProbeResult | null;
}): UiState {
  const { job, probing, probeResult } = params;

  if (job) {
    switch (job.status) {
      case "running":
      case "queued":
      case "probing":
        return "running";
      case "aborted":
        return "aborted";
      case "failed":
        return "partial";
      case "completed": {
        const totalProcessed = job.pages_crawled + job.pages_skipped + job.pages_errored;
        return totalProcessed >= job.max_pages ? "capped" : "completed";
      }
      default:
        return "running";
    }
  }

  if (probing) return "probing";
  if (probeResult && !probeResult.ok) return "invalid";
  if (probeResult && probeResult.ok && !probeResult.robots.allowed) return "robots-blocked";
  return "idle";
}

export const STATE_COLORS: Record<UiState, string> = {
  idle: "text-ac/50 border-ac/30",
  probing: "text-warn border-warn/40 animate-pulse",
  invalid: "text-danger border-danger/40",
  "robots-blocked": "text-warn border-warn/40",
  running: "text-ac border-ac/50 animate-pulse",
  capped: "text-warn border-warn/50",
  completed: "text-ac border-ac/60",
  partial: "text-danger border-danger/40",
  aborted: "text-ac-dim border-ac-dim/40",
};
