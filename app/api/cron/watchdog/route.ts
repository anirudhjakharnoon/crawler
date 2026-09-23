import { NextRequest, NextResponse } from "next/server";
import { WATCHDOG_STALE_MS } from "@/lib/constants";
import { kickOffTick } from "@/lib/crawl/invokeTick";
import { assertInternalRequest, errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs every ~1 minute (see vercel.json). Finds jobs stuck in 'running'
 * whose `last_ticked_at` (or, for a job that hasn't ticked even once yet,
 * `created_at`) is older than WATCHDOG_STALE_MS, and re-invokes `tick` for
 * each. This is the guarantee-of-forward-progress backstop: a tick's
 * self-fetch chain can be lost (a Vercel deploy, a transient network blip,
 * the function getting killed mid-flight), and this is what notices and
 * resumes it.
 */
export async function GET(req: NextRequest) {
  if (!assertInternalRequest(req)) {
    return errorResponse("Unauthorized", 401);
  }

  const admin = getSupabaseAdmin();
  const staleBefore = new Date(Date.now() - WATCHDOG_STALE_MS).toISOString();

  const { data: staleJobs, error } = await admin
    .from("crawl_jobs")
    .select("id")
    .eq("status", "running")
    .or(`last_ticked_at.lt.${staleBefore},and(last_ticked_at.is.null,created_at.lt.${staleBefore})`);

  if (error) {
    return errorResponse(`Watchdog query failed: ${error.message}`, 500);
  }

  const jobs = staleJobs ?? [];
  for (const job of jobs) {
    kickOffTick(req.nextUrl.origin, job.id);
  }

  return NextResponse.json({ requeued: jobs.length, jobIds: jobs.map((j) => j.id) });
}
