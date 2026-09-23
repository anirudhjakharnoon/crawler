import { NextRequest, NextResponse } from "next/server";
import { BOT_NAME, TICK_TIME_BUDGET_MS, buildUserAgent } from "@/lib/constants";
import { kickOffTick } from "@/lib/crawl/invokeTick";
import { processTickBatch } from "@/lib/crawl/tick";
import { assertInternalRequest, errorResponse } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Pro plan's serverless-function ceiling is 60s (Hobby is capped at
// 10s and cannot run this route usefully; Enterprise can go to 900s). We
// use the full 60s here and keep the in-process soft budget
// (TICK_TIME_BUDGET_MS, ~50s) a bit under it so there's always time left to
// finish writing the current row's DB state and, if needed, hand off to a
// fresh invocation before Vercel forcibly kills this one.
export const maxDuration = 60;

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
    kickOffTick(req.nextUrl.origin, jobId);
  }

  return NextResponse.json({
    ...lastResult,
    processedThisInvocation: processedTotal,
    continuing: stillHasWork,
  });
}
