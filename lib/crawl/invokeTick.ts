/**
 * Fire-and-forget invocation of the tick worker. Used by job creation
 * (kick off the first tick), the tick route itself (continue in a fresh
 * invocation once the soft time budget is spent), and the watchdog cron
 * (resume a stalled job). Never awaited by the caller's response — but
 * registered with `waitUntil` so Vercel keeps the function alive long
 * enough for the request to actually go out.
 */
import { waitUntil } from "@vercel/functions";
import { internalAuthHeaders } from "@/lib/http";

export function kickOffTick(origin: string, jobId: string): void {
  const url = `${origin}/api/jobs/${jobId}/tick`;
  const promise = fetch(url, {
    method: "POST",
    headers: internalAuthHeaders(),
  }).catch(() => {
    // Best-effort — if this particular kick is lost, the watchdog cron
    // will pick the job back up within WATCHDOG_STALE_MS.
  });
  waitUntil(promise);
}
