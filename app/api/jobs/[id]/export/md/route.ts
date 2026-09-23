import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Short-lived — the client fetches a fresh one on every click, never caches it. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

interface RouteParams {
  params: { id: string };
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const serverClient = getSupabaseServerClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();
  if (!user) return errorResponse("No anonymous session found", 401);

  const admin = getSupabaseAdmin();
  const { data: job } = await admin
    .from("crawl_jobs")
    .select("id, owner, md_storage_path")
    .eq("id", params.id)
    .maybeSingle();

  if (!job || job.owner !== user.id) {
    return errorResponse("Job not found", 404);
  }
  if (!job.md_storage_path) {
    return errorResponse("This job's Markdown export isn't ready yet.", 404);
  }

  const { data, error } = await admin.storage
    .from("exports")
    .createSignedUrl(job.md_storage_path, SIGNED_URL_TTL_SECONDS);

  if (error || !data) {
    return errorResponse("Failed to generate a signed download URL", 500);
  }

  return NextResponse.json({ url: data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
}
