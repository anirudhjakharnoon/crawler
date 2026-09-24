/**
 * Fire-and-forget invocation of the tick worker. Used by job creation
 * (kick off the first tick), the tick route itself (continue in a fresh
 * invocation once the soft time budget is spent), and the watchdog cron
 * (resume a stalled job). Never awaited by the caller's response — but
 * registered with `waitUntil` so Vercel keeps the function alive long
 * enough for the request to actually go out.
 *
 * Failures here are otherwise completely invisible: `fetch()` only rejects
 * on a network-level error, not on an HTTP error status (a 401 from
 * `assertInternalRequest`, a platform-level block, a 500 from an uncaught
 * exception in the tick route, etc. all resolve normally). A job whose
 * self-invoke fails this way would sit at status='running' with zero
 * progress and zero explanation until the next watchdog sweep — which, on
 * Vercel's Hobby plan, can be up to ~24h away (see README §3.1). So every
 * failure path here is both logged (visible in Vercel's Runtime Logs) and,
 * when a Supabase client is available, written directly to `crawl_events`
 * so it shows up in the UI's own Event Log immediately.
 */
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { internalAuthHeaders } from "@/lib/http";
import type { Database } from "@/lib/supabase/types";

async function recordKickOffFailure(
  supabase: SupabaseClient<Database> | undefined,
  jobId: string,
  detail: string
): Promise<void> {
  console.error(`kickOffTick: self-invoke for job ${jobId} failed — ${detail}`);
  if (!supabase) return;
  try {
    await supabase.from("crawl_events").insert({
      job_id: jobId,
      kind: "error",
      message: `Worker self-invoke failed (${detail}). It will be retried automatically by the watchdog cron — see README "Cron entries" for how often that runs on your Vercel plan.`,
    });
  } catch {
    // Best-effort logging only — never let this throw into the caller.
  }
}

export function kickOffTick(origin: string, jobId: string, supabase?: SupabaseClient<Database>): void {
  const url = `${origin}/api/jobs/${jobId}/tick`;
  const promise = fetch(url, {
    method: "POST",
    headers: internalAuthHeaders(),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        await recordKickOffFailure(supabase, jobId, `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : "unknown fetch error";
      await recordKickOffFailure(supabase, jobId, message);
    });
  waitUntil(promise);
}
