/**
 * The core, idempotent/re-entrant crawl worker. `processTickBatch` handles
 * exactly one bounded batch of the frontier for a single job:
 *
 *   robots check -> SSRF-safe fetch -> extract per selected content types ->
 *   write crawl_pages/crawl_assets -> write a crawl_events row -> mark the
 *   queue row done/skipped/error -> enqueue newly discovered same-domain
 *   links (respecting max_depth/max_pages) -> batch-update crawl_jobs
 *   counters once at the end.
 *
 * The route handler (`app/api/jobs/[id]/tick/route.ts`) loops this while a
 * ~50s soft time budget remains and the frontier isn't empty, then either
 * self-fetches to continue in a fresh invocation or returns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_ASSETS_PER_JOB,
  MAX_JOB_WALL_CLOCK_MS,
  MAX_TEXT_BYTES,
  MIN_WORDS_BEFORE_RENDER_FALLBACK,
  TICK_BATCH_SIZE,
  isJsRenderingEnabled,
  type ContentType,
  type JobStatus,
} from "@/lib/constants";
import { clampRateLimitRps } from "@/lib/rateLimiter";
import { renderPage } from "@/lib/render";
import { getRobotsForDomain, robotsUrlAllows } from "@/lib/robots";
import { safeFetch, SsrfError } from "@/lib/ssrf";
import { extractAssets, extractLinks, extractMainContent, normalizeUrl } from "@/lib/extract";
import { getRegistrableDomain } from "@/lib/domain";
import type { Database } from "@/lib/supabase/types";
import { assembleMarkdownDocument } from "./assemble";

export interface TickResult {
  jobId: string;
  processedCount: number;
  frontierEmpty: boolean;
  jobStatus: JobStatus;
  capped: boolean;
}

export interface TickDeps {
  userAgent: string;
  botToken: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function domainOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

interface Counters {
  pages_crawled: number;
  pages_skipped: number;
  pages_errored: number;
  images_found: number;
  videos_found: number;
  text_bytes: number;
  robots_disallowed: number;
}

function emptyCounters(): Counters {
  return {
    pages_crawled: 0,
    pages_skipped: 0,
    pages_errored: 0,
    images_found: 0,
    videos_found: 0,
    text_bytes: 0,
    robots_disallowed: 0,
  };
}

export async function processTickBatch(
  supabase: SupabaseClient<Database>,
  jobId: string,
  deps: TickDeps
): Promise<TickResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;

  const { data: job, error: jobError } = await supabase
    .from("crawl_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (jobError || !job) {
    return { jobId, processedCount: 0, frontierEmpty: false, jobStatus: "failed", capped: false };
  }

  if (job.status !== "running") {
    return { jobId, processedCount: 0, frontierEmpty: false, jobStatus: job.status, capped: false };
  }

  // Hard wall-clock ceiling — finalize with whatever we have so far.
  if (job.started_at && now() - new Date(job.started_at).getTime() > MAX_JOB_WALL_CLOCK_MS) {
    await finalizeJob(supabase, job, "failed", "Exceeded maximum job wall-clock time");
    return { jobId, processedCount: 0, frontierEmpty: true, jobStatus: "failed", capped: false };
  }

  const rps = clampRateLimitRps(job.rate_limit_rps);
  const intervalMs = 1000 / rps;

  const { data: recentDone } = await supabase
    .from("crawl_queue")
    .select("fetched_at")
    .eq("job_id", jobId)
    .not("fetched_at", "is", null)
    .order("fetched_at", { ascending: false })
    .limit(1);

  let lastRequestAt = recentDone?.[0]?.fetched_at ? new Date(recentDone[0].fetched_at).getTime() : 0;

  const { data: batch } = await supabase
    .from("crawl_queue")
    .select("*")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("depth", { ascending: true })
    .order("id", { ascending: true })
    .limit(TICK_BATCH_SIZE);

  if (!batch || batch.length === 0) {
    await finalizeJob(supabase, job, "completed", null);
    return { jobId, processedCount: 0, frontierEmpty: true, jobStatus: "completed", capped: false };
  }

  const contentTypes = new Set<ContentType>(job.content_types);
  const counters = emptyCounters();
  let assetsInsertedThisJobEstimate = 0; // refined via a count query below
  const { count: existingAssetCount } = await supabase
    .from("crawl_assets")
    .select("*", { count: "exact", head: true })
    .eq("job_id", jobId);
  assetsInsertedThisJobEstimate = existingAssetCount ?? 0;

  const { count: existingQueueCount } = await supabase
    .from("crawl_queue")
    .select("*", { count: "exact", head: true })
    .eq("job_id", jobId);
  let queueSize = existingQueueCount ?? 0;

  const alreadyProcessedTotal = job.pages_crawled + job.pages_skipped + job.pages_errored;
  let runningTextBytes = job.text_bytes;

  let processedCount = 0;
  let cappedThisBatch = false;

  for (const row of batch) {
    if (alreadyProcessedTotal + processedCount >= job.max_pages) {
      cappedThisBatch = true;
      break;
    }

    await supabase.from("crawl_queue").update({ status: "fetching" }).eq("id", row.id);

    let target: URL;
    try {
      target = new URL(row.url);
    } catch {
      await supabase
        .from("crawl_queue")
        .update({ status: "error", skip_reason: "invalid_url", fetched_at: new Date(now()).toISOString() })
        .eq("id", row.id);
      counters.pages_errored += 1;
      processedCount += 1;
      await writeEvent(supabase, jobId, "error", `Invalid URL: ${row.url}`);
      continue;
    }

    let robotsAllowed = true;
    try {
      const robots = await getRobotsForDomain(supabase, domainOrigin(target), deps.userAgent, deps.botToken);
      robotsAllowed = robotsUrlAllows(robots, deps.botToken, target);
    } catch (err) {
      if (err instanceof SsrfError) {
        robotsAllowed = false;
      }
    }

    if (!robotsAllowed) {
      await supabase
        .from("crawl_queue")
        .update({ status: "skipped", skip_reason: "robots", fetched_at: new Date(now()).toISOString() })
        .eq("id", row.id);
      counters.pages_skipped += 1;
      counters.robots_disallowed += 1;
      processedCount += 1;
      await writeEvent(supabase, jobId, "skip", `Disallowed by robots.txt: ${row.url}`);
      continue;
    }

    const wait = intervalMs - (now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) {
      await sleep(wait);
    }

    let fetchResult;
    try {
      fetchResult = await safeFetch(row.url, {
        method: "GET",
        userAgent: deps.userAgent,
      });
    } catch (err) {
      lastRequestAt = now();
      const message = err instanceof Error ? err.message : "Unknown fetch error";
      await supabase
        .from("crawl_queue")
        .update({ status: "error", skip_reason: message, fetched_at: new Date(now()).toISOString() })
        .eq("id", row.id);
      counters.pages_errored += 1;
      processedCount += 1;
      await writeEvent(supabase, jobId, "error", `Fetch failed for ${row.url}: ${message}`);
      continue;
    }
    lastRequestAt = now();

    if (fetchResult.status < 200 || fetchResult.status >= 300) {
      await supabase
        .from("crawl_queue")
        .update({
          status: "error",
          http_status: fetchResult.status,
          skip_reason: `http_${fetchResult.status}`,
          fetched_at: new Date(now()).toISOString(),
        })
        .eq("id", row.id);
      counters.pages_errored += 1;
      processedCount += 1;
      await writeEvent(supabase, jobId, "error", `GET ${row.url} -> ${fetchResult.status}`);
      continue;
    }

    const contentTypeHeader = String(fetchResult.headers["content-type"] ?? "");
    const isHtml = contentTypeHeader.includes("html") || contentTypeHeader === "";
    let html = isHtml ? fetchResult.body.toString("utf-8") : "";

    let mainContent: ReturnType<typeof extractMainContent> | null = null;
    if (isHtml) {
      mainContent = extractMainContent(html, row.url);
      if (isJsRenderingEnabled() && mainContent.wordCount < MIN_WORDS_BEFORE_RENDER_FALLBACK) {
        const beforeWordCount = mainContent.wordCount;
        try {
          const rendered = await renderPage(row.url, deps.userAgent);
          html = rendered.html;
          mainContent = extractMainContent(html, row.url);
          await writeEvent(
            supabase,
            jobId,
            "extract",
            `Static HTML looked JS-rendered (${beforeWordCount}w) for ${row.url}; re-fetched with headless rendering (${mainContent.wordCount}w now)`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown render error";
          await writeEvent(
            supabase,
            jobId,
            "extract",
            `JS-rendering fallback failed for ${row.url}: ${message}; keeping static HTML (${beforeWordCount}w)`
          );
        }
      }
    }

    let extractedWords = 0;
    if (isHtml && contentTypes.has("text") && mainContent) {
      const { title, markdown, wordCount } = mainContent;
      const bytes = Buffer.byteLength(markdown, "utf-8");
      if (runningTextBytes + bytes <= MAX_TEXT_BYTES) {
        await supabase.from("crawl_pages").insert({
          job_id: jobId,
          url: row.url,
          title,
          markdown,
          word_count: wordCount,
          fetched_at: new Date(now()).toISOString(),
        });
        runningTextBytes += bytes;
        counters.text_bytes += bytes;
        extractedWords = wordCount;
      }
    }

    if (isHtml && (contentTypes.has("images") || contentTypes.has("video"))) {
      const assets = extractAssets(html, row.url);
      const toInsert: Database["public"]["Tables"]["crawl_assets"]["Insert"][] = [];

      if (contentTypes.has("images")) {
        for (const img of assets.images) {
          toInsert.push({
            job_id: jobId,
            page_url: row.url,
            asset_type: "image",
            asset_url: img.url,
            alt_text: img.altText ?? null,
          });
        }
      }
      if (contentTypes.has("video")) {
        for (const vid of assets.videos) {
          toInsert.push({
            job_id: jobId,
            page_url: row.url,
            asset_type: "video",
            asset_url: vid.url,
            mime_type: vid.mimeType ?? null,
          });
        }
        for (const embed of assets.videoEmbeds) {
          toInsert.push({
            job_id: jobId,
            page_url: row.url,
            asset_type: "video_embed",
            asset_url: embed.url,
            alt_text: embed.altText ?? null,
          });
        }
      }

      const room = MAX_ASSETS_PER_JOB - assetsInsertedThisJobEstimate;
      const bounded = toInsert.slice(0, Math.max(0, room));
      if (bounded.length > 0) {
        await supabase.from("crawl_assets").insert(bounded);
        assetsInsertedThisJobEstimate += bounded.length;
        counters.images_found += bounded.filter((a) => a.asset_type === "image").length;
        counters.videos_found += bounded.filter((a) => a.asset_type !== "image").length;
      }
    }

    if (job.scope !== "page" && row.depth < job.max_depth && isHtml) {
      const jobRootDomain = job.root_domain;
      const links = extractLinks(html, row.url).filter(
        (link) => getRegistrableDomain(new URL(link).hostname) === jobRootDomain
      );

      const roomForNewUrls = job.max_pages - queueSize;
      if (roomForNewUrls > 0 && links.length > 0) {
        const candidates = links.slice(0, roomForNewUrls).map((link) => ({
          job_id: jobId,
          url: link,
          normalized_url: normalizeUrl(link),
          depth: row.depth + 1,
          discovered_from: row.url,
        }));
        if (candidates.length > 0) {
          const { error: insertErr, count } = await supabase
            .from("crawl_queue")
            .upsert(candidates, { onConflict: "job_id,normalized_url", ignoreDuplicates: true, count: "exact" });
          if (!insertErr && typeof count === "number") {
            queueSize += count;
          } else if (!insertErr) {
            queueSize += candidates.length;
          }
        }
      }
    }

    await supabase
      .from("crawl_queue")
      .update({ status: "done", http_status: fetchResult.status, fetched_at: new Date(now()).toISOString() })
      .eq("id", row.id);
    counters.pages_crawled += 1;
    processedCount += 1;
    await writeEvent(
      supabase,
      jobId,
      "fetch",
      `GET ${row.url} -> ${fetchResult.status} (${fetchResult.body.length}b${
        extractedWords ? `, ${extractedWords}w` : ""
      })`
    );
  }

  const totalProcessedAfter = alreadyProcessedTotal + processedCount;
  const capped = cappedThisBatch || totalProcessedAfter >= job.max_pages;

  await supabase
    .from("crawl_jobs")
    .update({
      pages_crawled: job.pages_crawled + counters.pages_crawled,
      pages_skipped: job.pages_skipped + counters.pages_skipped,
      pages_errored: job.pages_errored + counters.pages_errored,
      images_found: job.images_found + counters.images_found,
      videos_found: job.videos_found + counters.videos_found,
      text_bytes: job.text_bytes + counters.text_bytes,
      robots_disallowed: job.robots_disallowed + counters.robots_disallowed,
      last_ticked_at: new Date(now()).toISOString(),
    })
    .eq("id", jobId);

  if (capped) {
    const { data: freshJob } = await supabase.from("crawl_jobs").select("*").eq("id", jobId).maybeSingle();
    if (freshJob) {
      await finalizeJob(supabase, freshJob, "completed", null);
    }
    return { jobId, processedCount, frontierEmpty: true, jobStatus: "completed", capped: true };
  }

  const { count: remainingPending } = await supabase
    .from("crawl_queue")
    .select("*", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("status", "pending");

  const frontierEmpty = (remainingPending ?? 0) === 0;

  if (frontierEmpty) {
    const { data: freshJob } = await supabase.from("crawl_jobs").select("*").eq("id", jobId).maybeSingle();
    if (freshJob) {
      await finalizeJob(supabase, freshJob, "completed", null);
    }
    return { jobId, processedCount, frontierEmpty: true, jobStatus: "completed", capped: false };
  }

  return { jobId, processedCount, frontierEmpty: false, jobStatus: "running", capped: false };
}

async function writeEvent(
  supabase: SupabaseClient<Database>,
  jobId: string,
  kind: "fetch" | "extract" | "queue" | "skip" | "error" | "done",
  message: string
): Promise<void> {
  await supabase.from("crawl_events").insert({ job_id: jobId, kind, message });
}

async function finalizeJob(
  supabase: SupabaseClient<Database>,
  job: Database["public"]["Tables"]["crawl_jobs"]["Row"],
  status: "completed" | "failed" | "aborted",
  errorMessage: string | null
): Promise<void> {
  const { data: pages } = await supabase
    .from("crawl_pages")
    .select("url,title,markdown,fetched_at")
    .eq("job_id", job.id);

  const markdown = assembleMarkdownDocument({
    targetUrl: job.target_url,
    scope: job.scope,
    crawledAt: new Date(),
    pages: pages ?? [],
  });

  const buffer = Buffer.from(markdown, "utf-8");
  const path = `${job.id}/output.md`;

  const { error: uploadError } = await supabase.storage.from("exports").upload(path, buffer, {
    contentType: "text/markdown; charset=utf-8",
    upsert: true,
  });

  await supabase
    .from("crawl_jobs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      md_storage_path: uploadError ? null : path,
      md_size_bytes: uploadError ? null : buffer.byteLength,
      error_message: errorMessage,
      last_ticked_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  // Any URLs still sitting in the frontier when we finalize (hit a cap, or
  // the job was aborted) are done, definitively — leave no stale "pending"
  // rows behind for the UI to puzzle over.
  await supabase
    .from("crawl_queue")
    .update({ status: "skipped", skip_reason: status === "aborted" ? "aborted" : "cap" })
    .eq("job_id", job.id)
    .eq("status", "pending");

  await writeEvent(
    supabase,
    job.id,
    "done",
    status === "completed" ? "Crawl completed and export assembled." : `Crawl ended: ${status}.`
  );
}
