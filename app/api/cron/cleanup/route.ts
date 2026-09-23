import { NextRequest, NextResponse } from "next/server";
import { RETENTION_WINDOW_MS } from "@/lib/constants";
import { assertInternalRequest, errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs hourly (see vercel.json). Deletes Storage objects + DB rows for jobs
 * older than RETENTION_WINDOW_MS (default 48h, lib/constants.ts) — child
 * rows (crawl_queue/crawl_pages/crawl_assets/crawl_events) cascade via the
 * FK `on delete cascade`. Also opportunistically prunes expired
 * `robots_cache` rows so that table doesn't grow unbounded.
 */
export async function GET(req: NextRequest) {
  if (!assertInternalRequest(req)) {
    return errorResponse("Unauthorized", 401);
  }

  const admin = getSupabaseAdmin();
  const cutoffIso = new Date(Date.now() - RETENTION_WINDOW_MS).toISOString();

  const { data: oldJobs, error } = await admin
    .from("crawl_jobs")
    .select("id, md_storage_path")
    .lt("created_at", cutoffIso);

  if (error) {
    return errorResponse(`Cleanup query failed: ${error.message}`, 500);
  }

  const jobs = oldJobs ?? [];
  const storagePaths = jobs.map((j) => j.md_storage_path).filter((p): p is string => Boolean(p));

  let removedStorageObjects = 0;
  if (storagePaths.length > 0) {
    const { data: removed, error: removeErr } = await admin.storage.from("exports").remove(storagePaths);
    if (!removeErr) removedStorageObjects = removed?.length ?? storagePaths.length;
  }

  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length > 0) {
    await admin.from("crawl_jobs").delete().in("id", jobIds);
  }

  const nowIso = new Date().toISOString();
  await admin.from("robots_cache").delete().lt("expires_at", nowIso);

  return NextResponse.json({
    deletedJobs: jobIds.length,
    removedStorageObjects,
  });
}
