/**
 * Small, typed helpers shared by every API route — request-body parsing
 * without `any`, and the shared-secret check that protects the
 * worker/cron endpoints from being invoked by the public internet.
 */
import { NextResponse } from "next/server";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function parseJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Guards the tick/cron routes. When `CRON_SECRET` is configured (required
 * in production — see README), the caller must present it as a Bearer
 * token; Vercel Cron does this automatically for `/api/cron/*`, and our own
 * server code (job creation, tick self-continuation, watchdog) attaches it
 * explicitly for `/api/jobs/[id]/tick`. Without a configured secret we fail
 * OPEN only in non-production so local dev keeps working — this is called
 * out prominently in the README as a required production setting.
 */
export function assertInternalRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export function internalAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
