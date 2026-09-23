import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ABORTABLE_STATUSES = new Set(["queued", "probing", "running"]);

interface RouteParams {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const serverClient = getSupabaseServerClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();
  if (!user) return errorResponse("No anonymous session found", 401);

  const admin = getSupabaseAdmin();
  const { data: job } = await admin.from("crawl_jobs").select("*").eq("id", params.id).maybeSingle();

  if (!job || job.owner !== user.id) {
    return errorResponse("Job not found", 404);
  }

  if (!ABORTABLE_STATUSES.has(job.status)) {
    return errorResponse(`Job is already in a terminal state (${job.status})`, 409);
  }

  await admin
    .from("crawl_jobs")
    .update({ status: "aborted", finished_at: new Date().toISOString() })
    .eq("id", job.id);

  await admin
    .from("crawl_queue")
    .update({ status: "skipped", skip_reason: "aborted" })
    .eq("job_id", job.id)
    .eq("status", "pending");

  await admin.from("crawl_events").insert({
    job_id: job.id,
    kind: "done",
    message: "Job aborted by user request.",
  });

  return NextResponse.json({ ok: true, status: "aborted" });
}
