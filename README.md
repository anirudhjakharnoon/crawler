# CRAWLR

Precision website content extraction. Paste a URL, pick Text / Images /
Video, pick a scope, and run a robots.txt-respecting, SSRF-hardened
static-HTML crawl. No AI. No headless browser. No re-hosting. No login.

Stack: **Next.js 14 (App Router) + TypeScript + Tailwind**, deployed on
**Vercel**, backed entirely by **Supabase** (Postgres for data + the crawl
queue, Realtime for live progress, Storage for the final Markdown export,
Anonymous Auth as the only identity). There is no Redis, no external queue
service, no headless browser, no third-party scraping API, and no LLM/AI
call anywhere in this codebase.

---

## 1. Supabase setup

Everything below runs in the Supabase project's **SQL editor** (or via
`supabase db push` if you use the CLI). Both scripts are idempotent — safe
to re-run.

### 1.1 Enable Anonymous sign-ins

In the Supabase dashboard: **Authentication → Providers → Anonymous → Enable**.
There is no SQL for this step; it's a project setting. The app calls
`supabase.auth.signInAnonymously()` on first load — there is no signup/login
UI anywhere.

### 1.2 Schema migration — run this SQL script

This creates the 7 tables from the spec's Data Model section exactly as
given (`crawl_jobs`, `crawl_queue`, `crawl_pages`, `crawl_assets`,
`robots_cache`, `crawl_events`, `job_rate_limits`), enables Row Level
Security on every one of them, and turns on Realtime for `crawl_jobs`,
`crawl_events`, and `crawl_assets`. Full file: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

```sql
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
```

### 1.3 Storage bucket — run this SQL script

Creates a **private** `exports` bucket for the assembled Markdown files.
Full file: [`supabase/migrations/0002_storage.sql`](supabase/migrations/0002_storage.sql).

```sql
-- CRAWLR — Storage bucket for assembled Markdown exports.
-- Run this once, after 0001_init.sql.
--
-- The bucket is PRIVATE — every download goes through a short-lived signed
-- URL minted by `GET /api/jobs/[id]/export/md` (service-role key), never a
-- public URL. There is no automatic Storage "lifecycle" primitive in
-- Supabase, so retention is enforced by the app's own
-- `GET /api/cron/cleanup` route (hourly), which deletes objects for jobs
-- older than RETENTION_WINDOW_MS (48h, see lib/constants.ts) — see README.

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do update set public = excluded.public;

-- No anon SELECT/INSERT/UPDATE/DELETE policies are created for this bucket:
-- all access goes through the service-role client server-side (uploads in
-- the tick route, signed URLs in the export route, deletes in the cleanup
-- cron), which bypasses Storage RLS entirely. This keeps the bucket
-- unreachable by anyone holding only the anon key.
--
-- Note: we deliberately do NOT run
--   alter table storage.objects enable row level security;
-- here. Supabase already owns that table (it's created/managed by the
-- storage extension) and enables RLS on it by default in every project —
-- the SQL editor's role isn't the table owner, so attempting this
-- yourself fails with `must be owner of table objects`. There is nothing
-- left to do: RLS is on, and since no policies exist for the `exports`
-- bucket, only the service-role key (which bypasses RLS entirely) can
-- touch it.
```

> **Note on Storage "lifecycle":** Supabase Storage has no native
> time-based expiry primitive (unlike S3 lifecycle rules). Retention is
> instead enforced entirely by the app: `GET /api/cron/cleanup` (see below)
> deletes both the Storage object and its `crawl_jobs` row once a job is
> older than `RETENTION_WINDOW_MS`. This is a deliberate deviation from a
> literal "Storage lifecycle policy" (no such Supabase feature exists) —
> flagging it here per the deviation-reporting instruction.

### 1.4 Realtime — already handled above

`0001_init.sql`'s final `do $$ ... $$` block adds `crawl_jobs`,
`crawl_events`, and `crawl_assets` to the `supabase_realtime` publication
(guarded, safe to re-run). No separate dashboard toggle is required, but you
can double check under **Database → Replication** that all three tables are
listed.

`crawl_queue` is **not** Realtime-enabled per the spec's own Data Model
section — see "Documented deviations" below for how the client's live
Link Graph works around that.

---

## 2. Environment variables

Copy `.env.example` to `.env.local` (or set these in the Vercel project's
Environment Variables):

| Variable | Where it's used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Your project's API URL. Safe to expose. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | Anon key — RLS-scoped, safe to expose. |
| `SUPABASE_SERVICE_ROLE_KEY` | server only (`lib/supabase/admin.ts`, `import "server-only"`) | **Never** prefix with `NEXT_PUBLIC_`. Bypasses RLS — used only in API routes/tick/cron. |
| `NEXT_PUBLIC_APP_URL` | `lib/robots.ts` (User-Agent string), `lib/crawl/invokeTick.ts` (self-fetch origin) | e.g. `https://your-deployment.vercel.app`. |
| `CRON_SECRET` | `lib/http.ts` (`assertInternalRequest`) | Optional but recommended. Vercel Cron automatically sends this as a Bearer token when set in the Vercel project's env vars, so `/api/cron/*` and the tick self-fetch can be locked to "internal callers only" in production. Fails **open** (allows the request) only when `NODE_ENV !== "production"`, so local dev works without it. |

---

## 3. Vercel deployment

### 3.1 Cron entries (`vercel.json`, already in the repo)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/watchdog", "schedule": "* * * * *" },
    { "path": "/api/cron/cleanup", "schedule": "0 * * * *" }
  ]
}
```

- **watchdog** (every minute): re-invokes `tick` for any `status='running'`
  job whose `last_ticked_at` is older than `WATCHDOG_STALE_MS` (90s) — the
  forward-progress backstop if a self-fetch continuation chain is ever lost
  (e.g. a function crash mid-invocation).
- **cleanup** (hourly): deletes jobs (and their cascaded `crawl_queue` /
  `crawl_pages` / `crawl_assets` rows) plus their Storage object, once older
  than `RETENTION_WINDOW_MS` (48h). Also prunes expired `robots_cache` rows.

Vercel Cron requests carry a Bearer `CRON_SECRET` header automatically when
that env var is set on the project — no extra wiring needed.

### 3.2 `maxDuration` on the tick route

`app/api/jobs/[id]/tick/route.ts` sets `export const maxDuration = 60;`
— the ceiling for serverless functions on Vercel's **Pro** plan. **Hobby**
plan functions are capped at **10 seconds**, which is not enough for this
worker's soft time budget (`TICK_TIME_BUDGET_MS`, 50s) to ever complete a
useful batch before being killed mid-fetch. If you deploy on Hobby, either
lower `TICK_TIME_BUDGET_MS`/`TICK_BATCH_SIZE` substantially (expect much
slower crawls, more self-fetch hops, more watchdog-driven recoveries) or
upgrade to Pro. This is documented here per the spec's instruction to set
`maxDuration` "as high as the deployment plan allows."

---

## 4. Caps & limits (single source of truth: `lib/constants.ts`)

| Cap | Value | Purpose |
|---|---|---|
| `DEFAULT_MAX_PAGES` | 500 | Default per-job page cap (client-selectable up to the hard cap). |
| `HARD_MAX_PAGES` | 2000 | Server-side ceiling — the `crawl_jobs` check constraint enforces this even if a client sends more. |
| `DEFAULT_MAX_DEPTH` | 3 | Default BFS depth for `scope='site'`. |
| `HARD_MAX_DEPTH` | 5 | Server-side ceiling (`crawl_jobs` check constraint). |
| `TICK_TIME_BUDGET_MS` | 50,000 (50s) | Soft in-process time budget per `tick` invocation before it stops looping and either self-fetches to continue or finalizes. |
| `TICK_MAX_DURATION_S` | 60 | `maxDuration` on the tick route — Vercel Pro's serverless ceiling (see §3.2). |
| `MAX_JOB_WALL_CLOCK_MS` | 1,800,000 (30 min) | Absolute ceiling on total job age; a job started longer ago than this is force-failed by tick/watchdog even if still "running". |
| `MAX_TEXT_BYTES` | 15,728,640 (15 MB) | Combined extracted-text ceiling per job. |
| `MAX_RESPONSE_BYTES` | 10,485,760 (10 MB) | Per-fetch response size ceiling — `lib/ssrf.ts` aborts the stream past this. |
| `MAX_ASSETS_PER_JOB` | 5,000 | Ceiling on `crawl_assets` rows per job (images + videos + embeds combined). |
| `FETCH_TIMEOUT_MS` | 8,000 (8s) | Per-request fetch timeout in `lib/ssrf.ts`. |
| `MAX_REDIRECTS` | 5 | Max redirect hops manually followed; every hop is re-validated for SSRF. |
| `DEFAULT_ALLOWED_PORTS` | `[80, 443]` | Any other port is rejected unless it was explicitly present in the *original* user-supplied URL. |
| `DEFAULT_RATE_LIMIT_RPS` | 3 | Default per-domain request rate. |
| `HARD_MAX_RATE_LIMIT_RPS` | 5 | Hard server-side ceiling, enforced regardless of client input (`crawl_jobs` check constraint + `clampRateLimitRps`). |
| `JOB_CREATE_LIMIT_PER_WINDOW` / `JOB_CREATE_WINDOW_MS` | 5 per 3,600,000 ms (1h) | Per-anonymous-owner job-creation throttle (`job_rate_limits` table). Exceeding it returns `429` with a `Retry-After` header. |
| `ROBOTS_CACHE_TTL_MS` | 86,400,000 (24h) | `robots_cache` TTL before a domain's `robots.txt` is re-fetched. |
| `WATCHDOG_STALE_MS` | 90,000 (90s) | `last_ticked_at` older than this on a `running` job triggers a watchdog re-invocation. |
| `RETENTION_WINDOW_MS` | 172,800,000 (48h) | Age past which the cleanup cron deletes a job's rows + Storage object. |
| `ZIP_MAX_IMAGES` | 50 | The images-ZIP endpoint 400s above this image count. |
| `ZIP_MAX_TOTAL_BYTES` | 26,214,400 (25 MB) | HEAD-estimated total size ceiling for the images-ZIP endpoint. |

All of the above are one `export const` in `lib/constants.ts` — change a
number there (respecting the paired hard ceilings, which also live in the
`crawl_jobs` table's check constraints in §1.2) to retune the whole app.

---

## 5. Architecture at a glance

- **Anonymous identity, no login UI.** `AuthProvider` calls
  `signInAnonymously()` invisibly on first load; that `auth.uid()` is the
  RLS key on every table and the job-creation rate-limit key.
- **SSRF-hardened fetch (`lib/ssrf.ts`)** is the only way any server code
  reaches an external URL. It rejects non-http(s) schemes, resolves DNS
  manually and rejects private/loopback/link-local/multicast/reserved IPs
  (explicitly including the cloud metadata address `169.254.169.254`),
  pins the actual socket to the validated IP (defeats DNS-rebinding
  TOCTOU), re-validates on every redirect hop (max 5), enforces an 8s
  timeout, and aborts the stream past a 10MB response size.
- **robots.txt + rate limiting (`lib/robots.ts`, `lib/rateLimiter.ts`):**
  every fetch is robots-checked first (`robots_cache`, 24h TTL) and
  spaced to at most `rate_limit_rps` (hard-capped at 5 rps server-side
  regardless of client input) per domain, under a descriptive User-Agent
  linking to `/about-crawlr`.
- **Extraction (`lib/extract.ts`):** cheerio-based boilerplate stripping +
  a hand-rolled Readability-style scoring heuristic, Turndown for
  HTML→Markdown, an image/video/video-embed extractor (embeds allowlisted
  to YouTube/Vimeo/Loom), and same-registrable-domain link extraction
  (via `psl`). No AI, ever.
- **The worker (`lib/crawl/tick.ts`, `POST /api/jobs/[id]/tick`)** is
  idempotent and re-entrant: each invocation processes a bounded batch,
  loops in-process under a soft time budget, then either self-fetches to
  continue in a fresh invocation (via `@vercel/functions`'s `waitUntil`)
  or finalizes the job (assembles the Markdown, uploads to Storage,
  flips `status`) once the frontier is empty or a cap is hit. The
  Cron watchdog is the backstop if a continuation chain is ever lost.
- **Client (App Router, `app/page.tsx`)** subscribes to Supabase Realtime
  on this job's `crawl_jobs` row and `crawl_events`/`crawl_assets` rows
  only — **no polling anywhere** — throttled to a 500ms flush interval
  (~2 re-renders/sec even under a burst of events).

---

## 6. Local development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project's values
npm run dev                  # http://localhost:3000
```

Quality gates (all must be clean before a change is considered done):

```bash
npx tsc --noEmit    # strict TypeScript, no `any` in crawl/extraction/security modules
npm run lint        # ESLint (next/core-web-vitals)
npx vitest run       # unit tests (lib/ssrf.ts, lib/robots.ts, lib/extract.ts) +
                     # one integration test running a full mocked-fetch crawl
npm run build        # production build
```

---

## 7. Documented deviations from the spec

These were called out as they came up rather than silently changed:

1. **Link Graph data source.** The spec's own Data Model section only
   enables Realtime on `crawl_jobs`/`crawl_events`(/`crawl_assets`) —
   `crawl_queue` has no Realtime channel. The live Link Graph is therefore
   driven by parsing URLs out of streamed `crawl_events` messages, not by
   subscribing to `crawl_queue` directly.
2. **"Capped" UI state.** The given `crawl_jobs.status` check constraint
   is `('queued','probing','running','completed','failed','aborted')` —
   it has no `'capped'` value. The "capped" UI state is derived
   client-side (`lib/client/uiState.ts`) from the job's own counters
   (e.g. `pages_crawled >= max_pages`) while `status` is still
   `'completed'`, rather than inventing a new status value.
3. **Rate limiting implementation.** Rather than a literal token-bucket
   data structure, per-domain pacing is implemented as fixed-interval
   spacing (`intervalMs = 1000 / rps`, with an injectable `sleep` for
   tests) inside `processTickBatch`, and the per-owner job-*creation*
   throttle is a simple Postgres-backed rolling window
   (`job_rate_limits`). Functionally equivalent hard cap (5 rps), simpler
   implementation, no extra service.
4. **Tick "recursion."** The spec describes the worker as both
   "recursively calling itself" and "self-fetching if time budget
   remains." Implemented as: loop in-process while under
   `TICK_TIME_BUDGET_MS`, then HTTP self-fetch (fire-and-forget via
   `waitUntil`) only if work remains after that budget — reconciling the
   two phrasings rather than picking one arbitrarily.
5. **Storage "lifecycle policy."** Supabase Storage has no native
   time-based object-expiry primitive (unlike S3 lifecycle rules).
   Retention is enforced entirely by the app's hourly cleanup cron
   instead — see §1.3.
6. **Pinned Supabase package versions.** `@supabase/supabase-js` and
   `@supabase/ssr` are pinned to exact versions (`2.45.4` / `0.5.2`, no
   caret ranges) because a later `supabase-js` 2.x minor redesigned the
   client's generic typing in a way that's incompatible with this
   `@supabase/ssr` version, breaking `tsc` across every module that
   touches the typed client. Pin both together when upgrading.
7. **Small utility libraries beyond cheerio/turndown.** `psl` (eTLD+1
   computation for same-domain link filtering), `ipaddr.js` (IP-range
   classification in the SSRF module), `domhandler` (cheerio's own AST
   types), `@vercel/functions` (`waitUntil` for reliable fire-and-forget
   continuation), `server-only` (build-time guard against leaking the
   service-role client into client bundles), and `archiver` (in-memory
   ZIP streaming for the images-bundle endpoint) are all small,
   dependency-free-of-network-calls utility libraries — not third-party
   services, scraping APIs, queues, or AI calls, so they're within the
   stack constraints.

---

## 8. Explicit scope boundaries (unchanged from spec)

- Static HTML only — no JavaScript rendering, no headless browser.
- Never bypasses logins, paywalls, or CAPTCHAs.
- Images/videos are always linked to their original source, never
  re-hosted or proxied by this app (except the final assembled Markdown
  file itself, which lives in the private `exports` Storage bucket behind
  short-lived signed URLs).
- No AI/LLM calls anywhere in the codebase.
