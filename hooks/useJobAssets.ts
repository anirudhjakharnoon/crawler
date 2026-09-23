"use client";

/**
 * Live-updating asset registry for the image gallery / video lists —
 * subscribes to `crawl_assets` INSERTs for this job (Realtime is enabled on
 * this table too, per the migration), throttled the same way as
 * `useJobRealtime`.
 */
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { CrawlAssetRow } from "@/lib/supabase/types";

const FLUSH_INTERVAL_MS = 500;

export function useJobAssets(jobId: string | null): CrawlAssetRow[] {
  const [assets, setAssets] = useState<CrawlAssetRow[]>([]);
  const bufferRef = useRef<CrawlAssetRow[]>([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!jobId || !isSupabaseConfigured()) {
      setAssets([]);
      return;
    }

    bufferRef.current = [];
    dirtyRef.current = false;
    setAssets([]);

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;

    async function loadInitial() {
      const { data } = await supabase
        .from("crawl_assets")
        .select("*")
        .eq("job_id", jobId)
        .order("discovered_at", { ascending: true });
      if (cancelled) return;
      bufferRef.current = data ?? [];
      setAssets(bufferRef.current);
    }

    void loadInitial();

    const channel = supabase
      .channel(`job-assets-${jobId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crawl_assets", filter: `job_id=eq.${jobId}` },
        (payload) => {
          bufferRef.current = [...bufferRef.current, payload.new as CrawlAssetRow];
          dirtyRef.current = true;
        }
      )
      .subscribe();

    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setAssets(bufferRef.current);
    }, FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(flush);
      void supabase.removeChannel(channel);
    };
  }, [jobId]);

  return assets;
}
