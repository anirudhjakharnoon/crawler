"use client";

/**
 * Command-Line-style run history — past `crawl_jobs` for this anonymous
 * identity. RLS (`owner = auth.uid()`) already scopes this to "my jobs
 * only"; no explicit owner filter needed. Polls lazily on demand
 * (`refresh()`) rather than subscribing, since the history drawer isn't a
 * "live" surface — it refreshes itself whenever a job transitions.
 */
import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { CrawlJobRow } from "@/lib/supabase/types";

export function useRunHistory(ready: boolean) {
  const [jobs, setJobs] = useState<CrawlJobRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setLoading(true);
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase
      .from("crawl_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);
    setJobs(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  return { jobs, loading, refresh };
}
