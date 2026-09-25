/**
 * Server-only Supabase client using the service-role key. Bypasses RLS —
 * used exclusively inside API routes (never imported by client components)
 * for the crawl worker, cron jobs, and anything that must read/write across
 * a job regardless of which anonymous owner "session" invoked the route.
 */
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertValidSupabaseUrl } from "./env";
import type { Database } from "./types";

let cached: SupabaseClient<Database> | null = null;

export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY server env vars"
    );
  }
  assertValidSupabaseUrl(url, "NEXT_PUBLIC_SUPABASE_URL");

  cached = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
