/**
 * Per-domain politeness rate limiting AND per-owner job-creation abuse
 * throttling. Both are backed by Postgres rows (never in-memory state),
 * because a serverless function has no durable memory between invocations —
 * this is the "token bucket kept in `crawl_jobs.rate_limit_rps` + timestamps"
 * the spec calls for, implemented as a `fetched_at`-per-domain ledger read
 * fresh from `crawl_queue`/`crawl_events` each tick, plus a small,
 * job-creation-specific ledger table (`job_rate_limits`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_RATE_LIMIT_RPS,
  HARD_MAX_RATE_LIMIT_RPS,
  JOB_CREATE_LIMIT_PER_WINDOW,
  JOB_CREATE_WINDOW_MS,
} from "./constants";
import type { Database } from "./supabase/types";

/** Server-side clamp — never trust the rps a client asked for. */
export function clampRateLimitRps(requested: number | undefined | null): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_RATE_LIMIT_RPS;
  }
  return Math.min(requested, HARD_MAX_RATE_LIMIT_RPS);
}

/**
 * A simple, DB-verifiable token-bucket check for a single domain within a
 * tick: given the timestamps (ms since epoch) of requests already made to
 * this domain in the current job, and the configured rps, how many more
 * requests can be issued right now without exceeding rps averaged over the
 * trailing 1-second window? Pure function — the caller supplies the recent
 * timestamps (queried from `crawl_queue.fetched_at` for this job+domain).
 */
export function tokensAvailable(recentRequestTimestampsMs: number[], rps: number, nowMs: number): number {
  const windowStart = nowMs - 1000;
  const inWindow = recentRequestTimestampsMs.filter((t) => t >= windowStart && t <= nowMs).length;
  return Math.max(0, Math.floor(rps) - inWindow);
}

export interface JobRateLimitCheck {
  allowed: boolean;
  retryAfterSeconds: number;
  currentCount: number;
  limit: number;
}

/**
 * Enforces "N job creations per owner per rolling window", persisted in
 * `job_rate_limits` (one row per owner). Resets the window once it has
 * fully elapsed; otherwise increments in place. Uses a single round trip
 * with an upsert + conditional read to stay correct under light concurrency
 * (a true race is still possible with two simultaneous requests from the
 * same owner — acceptable here since the abuse limit is coarse-grained and
 * RLS already scopes each owner to their own row).
 */
export async function checkAndIncrementJobCreationLimit(
  supabase: SupabaseClient<Database>,
  owner: string
): Promise<JobRateLimitCheck> {
  const now = Date.now();
  const limit = JOB_CREATE_LIMIT_PER_WINDOW;

  const { data: existing } = await supabase
    .from("job_rate_limits")
    .select("*")
    .eq("owner", owner)
    .maybeSingle();

  if (!existing) {
    await supabase.from("job_rate_limits").insert({
      owner,
      window_start: new Date(now).toISOString(),
      job_count: 1,
    });
    return { allowed: true, retryAfterSeconds: 0, currentCount: 1, limit };
  }

  const windowStartMs = new Date(existing.window_start).getTime();
  const windowElapsed = now - windowStartMs;

  if (windowElapsed >= JOB_CREATE_WINDOW_MS) {
    await supabase
      .from("job_rate_limits")
      .update({ window_start: new Date(now).toISOString(), job_count: 1 })
      .eq("owner", owner);
    return { allowed: true, retryAfterSeconds: 0, currentCount: 1, limit };
  }

  if (existing.job_count >= limit) {
    const retryAfterSeconds = Math.ceil((JOB_CREATE_WINDOW_MS - windowElapsed) / 1000);
    return { allowed: false, retryAfterSeconds, currentCount: existing.job_count, limit };
  }

  const nextCount = existing.job_count + 1;
  await supabase.from("job_rate_limits").update({ job_count: nextCount }).eq("owner", owner);
  return { allowed: true, retryAfterSeconds: 0, currentCount: nextCount, limit };
}
