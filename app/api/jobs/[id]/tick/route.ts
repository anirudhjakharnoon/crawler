import { NextRequest, NextResponse } from "next/server";
import { BOT_NAME, TICK_TIME_BUDGET_MS, buildUserAgent } from "@/lib/constants";
import { kickOffTick } from "@/lib/crawl/invokeTick";
import { processTickBatch } from "@/lib/crawl/tick";
import { assertInternalRequest, errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// With Fluid Compute (on by default for new Vercel projects, all plans),
// Vercel's own default+maximum function duration is 300s on Hobby, and
// 300s default / up to 800s (1800s beta) on Pro+ — see README "maxDuration"
// section. We use the full 300s here (safe on both plans) and keep the
// in-process soft budget (TICK_TIME_BUDGET_MS) a bit under it so there's
// always time left to finish writing the current row's DB state and, if
// needed, hand off to a fresh invocation before Vercel forcibly kills this
// one. If your project predates Fluid Compute and it's off (Project
// Settings → Functions), Hobby's ceiling instead reverts to 10s, in which
// case lower this back down to 10 or turn Fluid Compute on.
export const maxDuration = 300;

interface RouteParams {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  if (!assertInternalRequest(req)) {
    return errorResponse("Unauthorized", 401);
  }

  const jobId = params.id;
  const admin = getSupabaseAdmin();
  const userAgent = buildUserAgent(process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin);

  const start = Date.now();
  let processedTotal = 0;
  let lastResult = await processTickBatch(admin, jobId, { userAgent, botToken: BOT_NAME });
  processedTotal += lastResult.processedCount;

  while (
    lastResult.jobStatus === "running" &&
    !lastResult.frontierEmpty &&
    Date.now() - start < TICK_TIME_BUDGET_MS
  ) {
    lastResult = await processTickBatch(admin, jobId, { userAgent, botToken: BOT_NAME });
    processedTotal += lastResult.processedCount;
  }

  const stillHasWork = lastResult.jobStatus === "running" && !lastResult.frontierEmpty;
  if (stillHasWork) {
    kickOffTick(req.nextUrl.origin, jobId, admin);
  }

  return NextResponse.json({
    ...lastResult,
    processedThisInvocation: processedTotal,
    continuing: stillHasWork,
  });
}
