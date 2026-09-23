-- CRAWLR — initial schema
-- Run this once against your Supabase project's SQL editor (or via the
-- Supabase CLI: `supabase db push`). Safe to re-run: every statement is
-- guarded with IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS.
--
-- Tables: crawl_jobs, crawl_queue, crawl_pages, crawl_assets, robots_cache,
-- crawl_events, job_rate_limits — exactly the "Data Model" section of the
-- CRAWLR spec, RLS enabled on every one of them.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- crawl_jobs — one row per crawl run
-- ---------------------------------------------------------------------------
create table if not exists crawl_jobs (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  target_url        text not null,
  root_domain       text not null,
  scope             text not null check (scope in ('page','linked','site')),
  content_types     text[] not null,
  status            text not null default 'queued'
                     check (status in ('queued','probing','running','completed','failed','aborted')),
  max_pages         int  not null default 500,
  max_depth         int  not null default 3,
  rate_limit_rps    numeric not null default 3,
  pages_crawled     int not null default 0,
  pages_skipped     int not null default 0,
  pages_errored     int not null default 0,
  images_found      int not null default 0,
  videos_found      int not null default 0,
  text_bytes        bigint not null default 0,
  robots_disallowed int not null default 0,
  started_at        timestamptz,
  finished_at       timestamptz,
  last_ticked_at    timestamptz,
  error_message     text,
  md_storage_path   text,
  md_size_bytes     bigint,
  constraint crawl_jobs_max_pages_bounds check (max_pages > 0 and max_pages <= 2000),
  constraint crawl_jobs_max_depth_bounds check (max_depth >= 0 and max_depth <= 5),
  constraint crawl_jobs_rate_limit_bounds check (rate_limit_rps > 0 and rate_limit_rps <= 5)
);

create index if not exists crawl_jobs_owner_created_at_idx on crawl_jobs (owner, created_at desc);
create index if not exists crawl_jobs_status_last_ticked_idx on crawl_jobs (status, last_ticked_at);

-- ---------------------------------------------------------------------------
-- crawl_queue — BFS frontier + processed record
-- ---------------------------------------------------------------------------
create table if not exists crawl_queue (
  id               bigint generated always as identity primary key,
  job_id           uuid not null references crawl_jobs(id) on delete cascade,
  url              text not null,
  normalized_url   text not null,
  depth            int not null default 0,
  status           text not null default 'pending'
                    check (status in ('pending','fetching','done','skipped','error')),
  discovered_from  text,
  http_status      int,
  skip_reason      text,
  fetched_at       timestamptz,
  unique (job_id, normalized_url)
);

create index if not exists crawl_queue_job_status_idx on crawl_queue (job_id, status);

-- ---------------------------------------------------------------------------
-- crawl_pages — extracted per-page content (assembled into one .md at
-- completion, never re-fetched from Storage until then)
-- ---------------------------------------------------------------------------
create table if not exists crawl_pages (
  id           bigint generated always as identity primary key,
  job_id       uuid not null references crawl_jobs(id) on delete cascade,
  url          text not null,
  title        text,
  markdown     text,
  word_count   int,
  fetched_at   timestamptz not null default now()
);

create index if not exists crawl_pages_job_idx on crawl_pages (job_id);

-- ---------------------------------------------------------------------------
-- crawl_assets — registry only, URLs never bytes
-- ---------------------------------------------------------------------------
create table if not exists crawl_assets (
  id            bigint generated always as identity primary key,
  job_id        uuid not null references crawl_jobs(id) on delete cascade,
  page_url      text not null,
  asset_type    text not null check (asset_type in ('image','video','video_embed')),
  asset_url     text not null,
  alt_text      text,
  mime_type     text,
  discovered_at timestamptz not null default now()
);

create index if not exists crawl_assets_job_idx on crawl_assets (job_id);
create index if not exists crawl_assets_job_type_idx on crawl_assets (job_id, asset_type);

-- ---------------------------------------------------------------------------
-- robots_cache — per-domain robots.txt / sitemap cache (24h TTL)
-- ---------------------------------------------------------------------------
create table if not exists robots_cache (
  domain        text primary key,
  robots_txt    text,
  sitemap_urls  text[],
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- ---------------------------------------------------------------------------
-- crawl_events — append-only live log, streamed to the UI via Realtime
-- ---------------------------------------------------------------------------
create table if not exists crawl_events (
  id         bigint generated always as identity primary key,
  job_id     uuid not null references crawl_jobs(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('fetch','extract','queue','skip','error','done')),
  message    text not null
);

create index if not exists crawl_events_job_at_idx on crawl_events (job_id, at);

-- ---------------------------------------------------------------------------
-- job_rate_limits — per-anonymous-owner job-creation throttle
-- ---------------------------------------------------------------------------
create table if not exists job_rate_limits (
  owner         uuid primary key references auth.users(id) on delete cascade,
  window_start  timestamptz not null default now(),
  job_count     int not null default 0
);

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled on every table above.
--   crawl_jobs        : owner = auth.uid()
--   child tables       : "job belongs to me" (job_id -> crawl_jobs.owner = auth.uid())
--   robots_cache       : shared, non-sensitive cache — public read, no anon writes
--   job_rate_limits    : owner = auth.uid(), no anon writes (service role only)
--
-- The app's own server code always mutates these tables via the
-- service-role client (lib/supabase/admin.ts), which bypasses RLS entirely.
-- These policies exist as the defense-in-depth layer for the anon key used
-- directly by the browser (Realtime subscriptions, and any direct reads).
-- ---------------------------------------------------------------------------

alter table crawl_jobs        enable row level security;
alter table crawl_queue       enable row level security;
alter table crawl_pages       enable row level security;
alter table crawl_assets      enable row level security;
alter table robots_cache      enable row level security;
alter table crawl_events      enable row level security;
alter table job_rate_limits   enable row level security;

drop policy if exists crawl_jobs_select_own on crawl_jobs;
create policy crawl_jobs_select_own on crawl_jobs
  for select using (owner = auth.uid());

drop policy if exists crawl_jobs_insert_own on crawl_jobs;
create policy crawl_jobs_insert_own on crawl_jobs
  for insert with check (owner = auth.uid());

drop policy if exists crawl_jobs_update_own on crawl_jobs;
create policy crawl_jobs_update_own on crawl_jobs
  for update using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists crawl_jobs_delete_own on crawl_jobs;
create policy crawl_jobs_delete_own on crawl_jobs
  for delete using (owner = auth.uid());

drop policy if exists crawl_queue_select_own_job on crawl_queue;
create policy crawl_queue_select_own_job on crawl_queue
  for select using (
    job_id in (select id from crawl_jobs where owner = auth.uid())
  );

drop policy if exists crawl_pages_select_own_job on crawl_pages;
create policy crawl_pages_select_own_job on crawl_pages
  for select using (
    job_id in (select id from crawl_jobs where owner = auth.uid())
  );

drop policy if exists crawl_assets_select_own_job on crawl_assets;
create policy crawl_assets_select_own_job on crawl_assets
  for select using (
    job_id in (select id from crawl_jobs where owner = auth.uid())
  );

drop policy if exists crawl_events_select_own_job on crawl_events;
create policy crawl_events_select_own_job on crawl_events
  for select using (
    job_id in (select id from crawl_jobs where owner = auth.uid())
  );

drop policy if exists robots_cache_select_all on robots_cache;
create policy robots_cache_select_all on robots_cache
  for select using (true);

drop policy if exists job_rate_limits_select_own on job_rate_limits;
create policy job_rate_limits_select_own on job_rate_limits
  for select using (owner = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime — crawl_jobs + crawl_events (+ crawl_assets) publish row changes.
-- The client subscribes filtered to `job_id=eq.<id>` (crawl_jobs uses `id`).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'crawl_jobs'
  ) then
    alter publication supabase_realtime add table crawl_jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'crawl_events'
  ) then
    alter publication supabase_realtime add table crawl_events;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'crawl_assets'
  ) then
    alter publication supabase_realtime add table crawl_assets;
  end if;
end $$;
