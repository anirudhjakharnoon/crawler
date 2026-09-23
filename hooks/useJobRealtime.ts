"use client";

/**
 * Subscribes to Supabase Realtime for exactly one job's `crawl_jobs` row and
 * `crawl_events` rows — no polling anywhere. Re-renders are throttled to at
 * most ~2/sec (a 500ms flush interval) even if events arrive faster, per the
 * spec's Realtime-message-storm guard. The ambient decorative layer never
 * reads this state; only the data readouts (counters, log lines, node
 * colors) do.
 */
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { CrawlEventRow, CrawlJobRow } from "@/lib/supabase/types";

const FLUSH_INTERVAL_MS = 500;
const MAX_EVENTS_BUFFERED = 300;

export interface JobRealtimeState {
  job: CrawlJobRow | null;
  events: CrawlEventRow[];
  loading: boolean;
}

export function useJobRealtime(jobId: string | null): JobRealtimeState {
  const [state, setState] = useState<JobRealtimeState>({ job: null, events: [], loading: Boolean(jobId) });

  const jobRef = useRef<CrawlJobRow | null>(null);
  const eventsRef = useRef<CrawlEventRow[]>([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!jobId || !isSupabaseConfigured()) {
      setState({ job: null, events: [], loading: false });
      return;
    }

    jobRef.current = null;
    eventsRef.current = [];
    dirtyRef.current = false;
    setState({ job: null, events: [], loading: true });

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;

    async function loadInitial() {
      const [{ data: job }, { data: events }] = await Promise.all([
        supabase.from("crawl_jobs").select("*").eq("id", jobId).maybeSingle(),
        supabase.from("crawl_events").select("*").eq("job_id", jobId).order("at", { ascending: true }).limit(MAX_EVENTS_BUFFERED),
      ]);
      if (cancelled) return;
      jobRef.current = job ?? null;
      eventsRef.current = events ?? [];
      dirtyRef.current = true;
      setState({ job: jobRef.current, events: eventsRef.current, loading: false });
    }

    void loadInitial();

    const channel = supabase
      .channel(`job-${jobId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crawl_jobs", filter: `id=eq.${jobId}` },
        (payload) => {
          jobRef.current = payload.new as CrawlJobRow;
          dirtyRef.current = true;
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crawl_events", filter: `job_id=eq.${jobId}` },
        (payload) => {
          const next = [...eventsRef.current, payload.new as CrawlEventRow];
          eventsRef.current = next.length > MAX_EVENTS_BUFFERED ? next.slice(-MAX_EVENTS_BUFFERED) : next;
          dirtyRef.current = true;
        }
      )
      .subscribe();

    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setState({ job: jobRef.current, events: eventsRef.current, loading: false });
    }, FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(flush);
      void supabase.removeChannel(channel);
    };
  }, [jobId]);

  return state;
}
