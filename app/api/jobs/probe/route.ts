import { NextRequest, NextResponse } from "next/server";
import { BOT_NAME, buildUserAgent } from "@/lib/constants";
import { probeUrl } from "@/lib/crawl/probe";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody(req);
  const url = body && typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return errorResponse("Missing required field 'url'", 400);
  }

  const appUrl = req.nextUrl.origin;
  const userAgent = buildUserAgent(process.env.NEXT_PUBLIC_APP_URL ?? appUrl);

  const result = await probeUrl(getSupabaseAdmin(), url, userAgent, BOT_NAME);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
