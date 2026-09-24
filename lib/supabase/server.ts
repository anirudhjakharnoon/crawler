/**
 * Request-scoped Supabase client for Route Handlers / Server Components.
 * Reads the anonymous-auth session from cookies via @supabase/ssr, so
 * queries run AS the calling anonymous user and are subject to RLS
 * (`owner = auth.uid()`), unlike `lib/supabase/admin.ts`.
 */
import "server-only";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertValidSupabaseUrl } from "./env";
import type { Database } from "./types";

export function getSupabaseServerClient(): SupabaseClient<Database> {
  const cookieStore = cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars");
  }
  assertValidSupabaseUrl(url, "NEXT_PUBLIC_SUPABASE_URL");

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Route Handlers running in a context where cookies() is read-only
          // (e.g. during static generation) — safe to ignore.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // see above
        }
      },
    },
  });
}
