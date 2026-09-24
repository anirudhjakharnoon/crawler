/**
 * Shared, friendlier validation for the Supabase URL env var. Without this,
 * a malformed value (stray quotes, a copy-pasted "KEY=" prefix, a missing
 * "https://", trailing whitespace, etc.) surfaces only as the browser's own
 * cryptic `TypeError: Failed to construct 'URL': Invalid URL` deep inside
 * @supabase/ssr — which doesn't say which env var is wrong or why. This
 * turns that into an actionable message pointing at the exact variable.
 */
export function assertValidSupabaseUrl(url: string, varName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${varName} is not a valid URL (got "${url}"). It should look exactly like ` +
        `https://your-project-ref.supabase.co — copy only the "Project URL" value ` +
        `from Supabase's Settings → API page, with no surrounding quotes, no ` +
        `"${varName}=" prefix, and no extra spaces or line breaks.`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${varName} must start with https:// (got "${url}")`);
  }
}
