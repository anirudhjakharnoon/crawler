import archiver from "archiver";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { FETCH_TIMEOUT_MS, ZIP_MAX_IMAGES, ZIP_MAX_TOTAL_BYTES, buildUserAgent } from "@/lib/constants";
import { buildZipEntryName } from "@/lib/crawl/zipNaming";
import { errorResponse } from "@/lib/http";
import { safeFetch } from "@/lib/ssrf";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  if (!job || job.owner !== user.id) return errorResponse("Job not found", 404);

  if (job.images_found === 0) {
    return errorResponse("No images were found for this job.", 400);
  }
  if (job.images_found > ZIP_MAX_IMAGES) {
    return errorResponse(
      `This job found ${job.images_found} images — bundling is only available for jobs with ${ZIP_MAX_IMAGES} or fewer. Use the CSV/JSON download instead.`,
      400
    );
  }

  const { data: assets } = await admin
    .from("crawl_assets")
    .select("asset_url")
    .eq("job_id", job.id)
    .eq("asset_type", "image")
    .limit(ZIP_MAX_IMAGES + 1);

  const imageUrls = (assets ?? []).map((a) => a.asset_url);
  if (imageUrls.length === 0) {
    return errorResponse("No images were found for this job.", 400);
  }
  if (imageUrls.length > ZIP_MAX_IMAGES) {
    return errorResponse(
      `This job has ${imageUrls.length} registered images — bundling is only available for ${ZIP_MAX_IMAGES} or fewer.`,
      400
    );
  }

  const userAgent = buildUserAgent(process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin);

  let estimatedTotalBytes = 0;
  for (const url of imageUrls) {
    try {
      const head = await safeFetch(url, { method: "HEAD", userAgent, timeoutMs: 4000 });
      const len = Number(head.headers["content-length"] ?? 0);
      if (Number.isFinite(len)) estimatedTotalBytes += len;
    } catch {
      // Unknown size — the real fetch below still enforces a hard per-file
      // cap, so this can't blow the response up unboundedly.
    }
  }

  if (estimatedTotalBytes > ZIP_MAX_TOTAL_BYTES) {
    return errorResponse(
      `Estimated bundle size (~${Math.round(estimatedTotalBytes / (1024 * 1024))}MB) exceeds the ${Math.round(
        ZIP_MAX_TOTAL_BYTES / (1024 * 1024)
      )}MB cap for in-memory ZIP bundling. Use the CSV/JSON list instead.`,
      400
    );
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("warning", () => {});
  archive.on("error", () => {
    archive.abort();
  });

  void (async () => {
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      if (!url) continue;
      try {
        const res = await safeFetch(url, {
          method: "GET",
          userAgent,
          timeoutMs: FETCH_TIMEOUT_MS,
          maxResponseBytes: ZIP_MAX_TOTAL_BYTES,
        });
        if (res.status >= 200 && res.status < 300) {
          archive.append(res.body, { name: buildZipEntryName(url, i) });
        }
      } catch {
        // Skip a single failed image; the rest of the bundle still ships.
      }
    }
    void archive.finalize();
  })();

  const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crawlr-${job.id}-images.zip"`,
      "Cache-Control": "no-store",
    },
  });
}