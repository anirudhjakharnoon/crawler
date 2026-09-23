/**
 * Hand-written row types mirroring the SQL migration in
 * `supabase/migrations/0001_init.sql` exactly. Kept minimal (no generated
 * client, no extra services) but typed enough that every table read/write
 * in the app is checked by `tsc` — this is why the crawl/API modules carry
 * no `any`.
 */
import type { AssetType, ContentType, EventKind, JobStatus, QueueStatus, Scope } from "@/lib/constants";

export interface CrawlJobRow {
  id: string;
  owner: string;
  created_at: string;
  target_url: string;
  root_domain: string;
  scope: Scope;
  content_types: ContentType[];
  status: JobStatus;
  max_pages: number;
  max_depth: number;
  rate_limit_rps: number;
  pages_crawled: number;
  pages_skipped: number;
  pages_errored: number;
  images_found: number;
  videos_found: number;
  text_bytes: number;
  robots_disallowed: number;
  started_at: string | null;
  finished_at: string | null;
  last_ticked_at: string | null;
  error_message: string | null;
  md_storage_path: string | null;
  md_size_bytes: number | null;
}

export type CrawlJobInsert = Partial<CrawlJobRow> &
  Pick<CrawlJobRow, "owner" | "target_url" | "root_domain" | "scope" | "content_types">;
export type CrawlJobUpdate = Partial<Omit<CrawlJobRow, "id" | "owner" | "created_at">>;

export interface CrawlQueueRow {
  id: number;
  job_id: string;
  url: string;
  normalized_url: string;
  depth: number;
  status: QueueStatus;
  discovered_from: string | null;
  http_status: number | null;
  skip_reason: string | null;
  fetched_at: string | null;
}

export type CrawlQueueInsert = Partial<CrawlQueueRow> &
  Pick<CrawlQueueRow, "job_id" | "url" | "normalized_url">;
export type CrawlQueueUpdate = Partial<Omit<CrawlQueueRow, "id" | "job_id">>;

export interface CrawlPageRow {
  id: number;
  job_id: string;
  url: string;
  title: string | null;
  markdown: string | null;
  word_count: number | null;
  fetched_at: string;
}

export type CrawlPageInsert = Partial<CrawlPageRow> & Pick<CrawlPageRow, "job_id" | "url">;

export interface CrawlAssetRow {
  id: number;
  job_id: string;
  page_url: string;
  asset_type: AssetType;
  asset_url: string;
  alt_text: string | null;
  mime_type: string | null;
  discovered_at: string;
}

export type CrawlAssetInsert = Partial<CrawlAssetRow> &
  Pick<CrawlAssetRow, "job_id" | "page_url" | "asset_type" | "asset_url">;

export interface RobotsCacheRow {
  domain: string;
  robots_txt: string | null;
  sitemap_urls: string[] | null;
  fetched_at: string;
  expires_at: string;
}

export type RobotsCacheUpsert = RobotsCacheRow;

export interface CrawlEventRow {
  id: number;
  job_id: string;
  at: string;
  kind: EventKind;
  message: string;
}

export type CrawlEventInsert = Pick<CrawlEventRow, "job_id" | "kind" | "message">;

export interface JobRateLimitRow {
  owner: string;
  window_start: string;
  job_count: number;
}

export interface Database {
  public: {
    Tables: {
      crawl_jobs: {
        Row: CrawlJobRow;
        Insert: CrawlJobInsert;
        Update: CrawlJobUpdate;
      };
      crawl_queue: {
        Row: CrawlQueueRow;
        Insert: CrawlQueueInsert;
        Update: CrawlQueueUpdate;
      };
      crawl_pages: {
        Row: CrawlPageRow;
        Insert: CrawlPageInsert;
        Update: Partial<CrawlPageRow>;
      };
      crawl_assets: {
        Row: CrawlAssetRow;
        Insert: CrawlAssetInsert;
        Update: Partial<CrawlAssetRow>;
      };
      robots_cache: {
        Row: RobotsCacheRow;
        Insert: RobotsCacheUpsert;
        Update: Partial<RobotsCacheRow>;
      };
      crawl_events: {
        Row: CrawlEventRow;
        Insert: CrawlEventInsert;
        Update: Partial<CrawlEventRow>;
      };
      job_rate_limits: {
        Row: JobRateLimitRow;
        Insert: Partial<JobRateLimitRow> & Pick<JobRateLimitRow, "owner">;
        Update: Partial<JobRateLimitRow>;
      };
    };
  };
}
