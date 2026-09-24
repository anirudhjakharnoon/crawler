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
