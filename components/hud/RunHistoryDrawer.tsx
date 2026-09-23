"use client";

import type { CrawlJobRow } from "@/lib/supabase/types";

interface RunHistoryDrawerProps {
  jobs: CrawlJobRow[];
  loading: boolean;
  onSelect: (job: CrawlJobRow) => void;
  activeJobId: string | null;
}

const STATUS_GLYPH: Record<string, string> = {
  queued: "○",
  probing: "◌",
  running: "◉",
  completed: "●",
  failed: "✕",
  aborted: "◌",
};

export function RunHistoryDrawer({ jobs, loading, onSelect, activeJobId }: RunHistoryDrawerProps) {
  return (
    <div className="h-full min-h-[220px] overflow-y-auto rounded-sm border border-ac/10 bg-black/40 p-3 font-mono text-[11px]">
      {loading && jobs.length === 0 && <p className="text-ac/30">loading history…</p>}
      {!loading && jobs.length === 0 && <p className="text-ac/30">no previous runs on this device yet.</p>}
      <ul className="space-y-1.5">
        {jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => onSelect(job)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-ac/5 ${
                job.id === activeJobId ? "bg-ac/10 text-ac" : "text-ac/60"
              }`}
            >
              <span className="w-4 shrink-0 text-center">{STATUS_GLYPH[job.status] ?? "?"}</span>
              <span className="flex-1 truncate">{job.target_url}</span>
              <span className="shrink-0 text-ac/30">{job.scope}</span>
              <span className="w-14 shrink-0 text-right text-ac/40">{job.pages_crawled}p</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
