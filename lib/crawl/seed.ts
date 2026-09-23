/**
 * Creates a `crawl_jobs` row and seeds `crawl_queue` (start URL at depth 0,
 * plus sitemap URLs at depth 0 when scope='site'), ready for the first tick.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_RATE_LIMIT_RPS,
  type ContentType,
  type Scope,
  maxDepthForScope,
} from "@/lib/constants";
import { getRegistrableDomain } from "@/lib/domain";
import { normalizeUrl } from "@/lib/extract";
import { parseUrlStrict } from "@/lib/ssrf";
import { fetchSitemapUrls } from "./sitemap";
import type { CrawlJobRow, Database } from "@/lib/supabase/types";

export interface CreateJobInput {
  owner: string;
  url: string;
  scope: Scope;
  contentTypes: ContentType[];
  userAgent: string;
}

export async function createJobAndSeed(
  supabase: SupabaseClient<Database>,
  input: CreateJobInput
): Promise<CrawlJobRow> {
  const parsed = parseUrlStrict(input.url); // throws SsrfError for bad scheme/format
  const rootDomain = getRegistrableDomain(parsed.hostname);
  const maxDepth = maxDepthForScope(input.scope);
  const nowIso = new Date().toISOString();

  const { data: job, error: jobErr } = await supabase
    .from("crawl_jobs")
    .insert({
      owner: input.owner,
      target_url: parsed.href,
      root_domain: rootDomain,
      scope: input.scope,
      content_types: input.contentTypes,
      status: "running",
      max_pages: DEFAULT_MAX_PAGES,
      max_depth: maxDepth,
      rate_limit_rps: DEFAULT_RATE_LIMIT_RPS,
      started_at: nowIso,
      last_ticked_at: nowIso,
    })
    .select("*")
    .single();

  if (jobErr || !job) {
    throw new Error(jobErr?.message ?? "Failed to create job");
  }

  const seedRows: Database["public"]["Tables"]["crawl_queue"]["Insert"][] = [
    {
      job_id: job.id,
      url: parsed.href,
      normalized_url: normalizeUrl(parsed.href),
      depth: 0,
    },
  ];

  if (input.scope === "site") {
    const origin = `${parsed.protocol}//${parsed.host}`;
    const sitemapUrls = await fetchSitemapUrls(`${origin}/sitemap.xml`, input.userAgent);
    const sameOrigin = sitemapUrls.filter((u) => {
      try {
        return getRegistrableDomain(new URL(u).hostname) === rootDomain;
      } catch {
        return false;
      }
    });
    for (const u of sameOrigin.slice(0, DEFAULT_MAX_PAGES - 1)) {
      seedRows.push({
        job_id: job.id,
        url: u,
        normalized_url: normalizeUrl(u),
        depth: 0,
        discovered_from: "sitemap.xml",
      });
    }
  }

  await supabase
    .from("crawl_queue")
    .upsert(seedRows, { onConflict: "job_id,normalized_url", ignoreDuplicates: true });

  await supabase.from("crawl_events").insert({
    job_id: job.id,
    kind: "queue",
    message: `Job created for ${parsed.href} (scope=${input.scope}, seeded ${seedRows.length} URL(s)).`,
  });

  return job;
}
