"use client";

/**
 * Typed fetch wrappers for the browser → our own API routes. No direct
 * Supabase table writes happen from the client for crawl data — everything
 * mutating goes through these routes, which use the service-role key
 * server-side. The client only ever *reads* via Supabase (Realtime + the
 * anon-key RLS-scoped selects the hooks below use for run history).
 */
import type { ContentType, Scope } from "@/lib/constants";
import type { ProbeResult } from "@/lib/crawl/probe";
import type { CrawlJobRow } from "@/lib/supabase/types";

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed with status ${res.status}`;
    const err = new Error(message) as Error & { status?: number; retryAfterSeconds?: number };
    err.status = res.status;
    if (body && typeof body === "object" && "retryAfterSeconds" in body) {
      err.retryAfterSeconds = Number(body.retryAfterSeconds);
    }
    throw err;
  }
  return body as T;
}

export async function probeTarget(url: string): Promise<ProbeResult> {
  const res = await fetch("/api/jobs/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return parseJsonOrThrow<ProbeResult>(res);
}

export interface CreateJobPayload {
  url: string;
  scope: Scope;
  contentTypes: ContentType[];
  ackPermission: true;
}

export async function createJob(payload: CreateJobPayload): Promise<{ job: CrawlJobRow }> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow<{ job: CrawlJobRow }>(res);
}

export async function abortJob(jobId: string): Promise<{ ok: true; status: string }> {
  const res = await fetch(`/api/jobs/${jobId}/abort`, { method: "POST" });
  return parseJsonOrThrow<{ ok: true; status: string }>(res);
}

export async function getFreshExportUrl(jobId: string): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await fetch(`/api/jobs/${jobId}/export/md`, { method: "GET", cache: "no-store" });
  return parseJsonOrThrow<{ url: string; expiresInSeconds: number }>(res);
}

export async function downloadImagesZip(jobId: string): Promise<Blob> {
  const res = await fetch(`/api/jobs/${jobId}/images/zip`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body && typeof body.error === "string" ? body.error : "Failed to bundle images";
    throw new Error(message);
  }
  return res.blob();
}
