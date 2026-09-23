import { NextRequest, NextResponse } from "next/server";
import { BOT_NAME, CONTENT_TYPES, SCOPES, buildUserAgent, type ContentType, type Scope } from "@/lib/constants";
import { createJobAndSeed } from "@/lib/crawl/seed";
import { kickOffTick } from "@/lib/crawl/invokeTick";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { checkAndIncrementJobCreationLimit } from "@/lib/rateLimiter";
import { SsrfError } from "@/lib/ssrf";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && (CONTENT_TYPES as readonly string[]).includes(value);
}

function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export async function POST(req: NextRequest) {
  const body = await parseJsonBody(req);
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const scope = body.scope;
  const contentTypesRaw = body.contentTypes;
  const ackPermission = body.ackPermission;

  if (!url) return errorResponse("Missing required field 'url'", 400);
  if (!isScope(scope)) {
    return errorResponse(`Invalid 'scope' — must be one of ${SCOPES.join(", ")}`, 400);
  }
  if (!Array.isArray(contentTypesRaw) || contentTypesRaw.length === 0 || !contentTypesRaw.every(isContentType)) {
    return errorResponse(`Invalid 'contentTypes' — must be a non-empty subset of ${CONTENT_TYPES.join(", ")}`, 400);
  }
  if (ackPermission !== true) {
    return errorResponse(
      "You must acknowledge that you have the right to crawl this target (ackPermission must be true).",
      400
    );
  }

  const serverClient = getSupabaseServerClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();

  if (!user) {
    return errorResponse("No anonymous session found. The client must sign in anonymously first.", 401);
  }

  const admin = getSupabaseAdmin();

  const limitCheck = await checkAndIncrementJobCreationLimit(admin, user.id);
  if (!limitCheck.allowed) {
    return NextResponse.json(
      {
        error: "Job creation rate limit exceeded",
        retryAfterSeconds: limitCheck.retryAfterSeconds,
        limit: limitCheck.limit,
      },
      { status: 429, headers: { "Retry-After": String(limitCheck.retryAfterSeconds) } }
    );
  }

  const userAgent = buildUserAgent(process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin);

  try {
    const job = await createJobAndSeed(admin, {
      owner: user.id,
      url,
      scope,
      contentTypes: contentTypesRaw,
      userAgent,
    });

    kickOffTick(req.nextUrl.origin, job.id);

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    if (err instanceof SsrfError) {
      return errorResponse(`Target URL rejected: ${err.message}`, 400, { code: err.code });
    }
    const message = err instanceof Error ? err.message : "Failed to create job";
    return errorResponse(message, 500);
  }
}
