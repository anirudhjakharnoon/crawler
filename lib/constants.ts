/**
 * Central home for every tunable cap/limit in the app. Keep this the single
 * source of truth so README "Caps & Limits" table and the code never drift.
 */

// ---- Crawl resource caps (hard server-side ceilings, independent of client input) ----
export const DEFAULT_MAX_PAGES = 500;
export const HARD_MAX_PAGES = 2000;

export const DEFAULT_MAX_DEPTH = 3;
export const HARD_MAX_DEPTH = 5;

/** Soft time budget per `tick` invocation before it stops recursing and returns. */
export const TICK_TIME_BUDGET_MS = 50_000;
/** `maxDuration` set on the tick route itself (Vercel Pro plan ceiling). */
export const TICK_MAX_DURATION_S = 60;

/** Total job wall-clock ceiling; watchdog/tick both check this and fail the job past it. */
export const MAX_JOB_WALL_CLOCK_MS = 30 * 60 * 1000; // 30 minutes

/** Combined extracted text size ceiling per job (bytes, approx via UTF-8 length). */
export const MAX_TEXT_BYTES = 15 * 1024 * 1024; // 15 MB

/** Per-fetch response size ceiling; stream is aborted past this. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Per-job asset registry ceiling (rows in crawl_assets), across images+videos+embeds. */
export const MAX_ASSETS_PER_JOB = 5000;

/** Per-request fetch timeout. */
export const FETCH_TIMEOUT_MS = 8_000;

/** Max redirect hops manually followed, re-validating SSRF on every hop. */
export const MAX_REDIRECTS = 5;

/** Allowed ports unless explicitly present in the user-supplied URL. */
export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

// ---- Rate limiting ----
export const DEFAULT_RATE_LIMIT_RPS = 3;
export const HARD_MAX_RATE_LIMIT_RPS = 5;

/** Per-anonymous-owner job creation throttle. */
export const JOB_CREATE_LIMIT_PER_WINDOW = 5;
export const JOB_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ---- Tick batching ----
export const TICK_BATCH_SIZE = 8;

// ---- robots.txt / sitemap cache ----
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---- Watchdog / cleanup ----
// last_ticked_at older than this on a running job => re-invoke tick. Note:
// the shipped vercel.json cron schedule only sweeps once/day on Vercel's
// Hobby plan (which forbids more-frequent cron jobs) — see README §3.1 for
// the Pro-plan schedule that actually honors this ~90s target.
export const WATCHDOG_STALE_MS = 90_000;
export const RETENTION_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h — jobs+storage older than this get purged

// ---- Images ZIP bundling ----
export const ZIP_MAX_IMAGES = 50;
export const ZIP_MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB, HEAD-estimated

// ---- User-Agent ----
export const BOT_NAME = "CrawlrBot";
export const BOT_VERSION = "1.0";

export function buildUserAgent(appUrl: string): string {
  return `${BOT_NAME}/${BOT_VERSION} (+${appUrl}/about-crawlr)`;
}

export const CONTENT_TYPES = ["text", "images", "video"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const SCOPES = ["page", "linked", "site"] as const;
export type Scope = (typeof SCOPES)[number];

export const JOB_STATUSES = [
  "queued",
  "probing",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const QUEUE_STATUSES = ["pending", "fetching", "done", "skipped", "error"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const ASSET_TYPES = ["image", "video", "video_embed"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const EVENT_KINDS = ["fetch", "extract", "queue", "skip", "error", "done"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export function maxDepthForScope(scope: Scope): number {
  if (scope === "page") return 0;
  if (scope === "linked") return 1;
  return DEFAULT_MAX_DEPTH;
}
