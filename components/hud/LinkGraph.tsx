"use client";

/**
 * The Split HUD's hero visual: a live node graph driven entirely by
 * Realtime `crawl_events` + `crawl_jobs` counters (never crawl_queue —
 * Realtime is only enabled on crawl_jobs/crawl_events/crawl_assets per the
 * migration, so this reads the settled fetch/skip/error events instead of
 * an in-flight "fetching" signal; see README "Deviations").
 *
 * Node positions are assigned once per discovered URL (golden-angle spiral,
 * banded into rings so a large crawl stays inside the panel) and cached in
 * a ref, so existing nodes never jump or replay their pop-in animation when
 * new ones are appended.
 */
import { useMemo, useRef } from "react";
import type { CrawlEventRow, CrawlJobRow } from "@/lib/supabase/types";

const GOLDEN_ANGLE = 137.508;
const RING_COUNT = 7;
const RING_STEP = 18;
const BASE_RADIUS = 16;
const MAX_RENDERED_NODES = 260;

type NodeKind = "fetch" | "skip" | "error";

interface GraphNode {
  key: string;
  url: string;
  kind: NodeKind;
  x: number;
  y: number;
}

function extractUrlFromMessage(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s)]+/);
  return match ? match[0].replace(/[),.]+$/, "") : null;
}

function isNodeKind(kind: string): kind is NodeKind {
  return kind === "fetch" || kind === "skip" || kind === "error";
}

const KIND_DOT_CLASS: Record<NodeKind, string> = {
  fetch: "bg-ac shadow-[0_0_8px_var(--ac)]",
  skip: "bg-warn shadow-[0_0_8px_var(--warn)]",
  error: "bg-danger shadow-[0_0_8px_var(--danger)]",
};

export function LinkGraph({ job, events }: { job: CrawlJobRow | null; events: CrawlEventRow[] }) {
  const slotRef = useRef<Map<string, number>>(new Map());
  const nextSlotRef = useRef(0);

  const nodes = useMemo<GraphNode[]>(() => {
    const result: GraphNode[] = [];
    for (const e of events) {
      if (!isNodeKind(e.kind)) continue;
      const url = extractUrlFromMessage(e.message);
      if (!url) continue;

      let slot = slotRef.current.get(url);
      if (slot === undefined) {
        slot = nextSlotRef.current;
        nextSlotRef.current += 1;
        slotRef.current.set(url, slot);
      }

      const angleDeg = slot * GOLDEN_ANGLE;
      const radius = BASE_RADIUS + (slot % RING_COUNT) * RING_STEP;
      const rad = (angleDeg * Math.PI) / 180;

      result.push({
        key: String(e.id),
        url,
        kind: e.kind,
        x: Math.cos(rad) * radius,
        y: Math.sin(rad) * radius,
      });
    }
    return result.slice(-MAX_RENDERED_NODES);
  }, [events]);

  const crawled = job?.pages_crawled ?? 0;
  const skipped = job?.pages_skipped ?? 0;
  const errored = job?.pages_errored ?? 0;
  const maxPages = job?.max_pages ?? 0;
  const totalProcessed = crawled + skipped + errored;
  const progressPct = maxPages > 0 ? Math.min(100, Math.round((totalProcessed / maxPages) * 100)) : 0;

  return (
    <div className="crt-corner panel-glass relative flex h-full min-h-[440px] flex-col overflow-hidden rounded-md p-5">
      <header className="mb-2 flex items-center justify-between gap-4">
        <h2 className="font-display text-sm uppercase tracking-[0.3em] text-ac/70">Link Graph</h2>
        <div className="truncate font-mono text-[11px] text-ac/40" title={job?.target_url ?? ""}>
          {job?.target_url ?? "awaiting target"}
        </div>
      </header>

      <div className="relative flex-1">
        <div className="absolute left-1/2 top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ac shadow-[0_0_18px_var(--ac)]">
          {job?.status === "running" && <span className="pulse-ring" aria-hidden />}
        </div>
        <div className="absolute left-1/2 top-1/2">
          {nodes.map((n) => (
            <div
              key={n.key}
              title={n.url}
              className={`node-pop absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${KIND_DOT_CLASS[n.kind]}`}
              style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 font-mono text-[11px]">
        <Stat label="Crawled" value={crawled} className="text-ac" />
        <Stat label="Skipped" value={skipped} className="text-warn" />
        <Stat label="Errored" value={errored} className="text-danger" />
        <Stat label="Cap" value={maxPages || "—"} className="text-ac/50" />
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full bg-ac transition-[width] duration-500 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number | string; className?: string }) {
  return (
    <div className="rounded-sm border border-ac/10 bg-black/30 px-2 py-1.5 text-center">
      <div className={`text-lg font-semibold ${className ?? ""}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-[0.2em] text-ac/40">{label}</div>
    </div>
  );
}
