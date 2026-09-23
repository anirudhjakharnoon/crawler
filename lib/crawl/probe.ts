/**
 * Pre-run probe: reachability + robots.txt + same-origin link count +
 * sitemap check, powering the UI's "RESOLVED · 200 OK · 48 LINKS FOUND"
 * readout with real data. Never creates a job or writes to the frontier.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRegistrableDomain } from "@/lib/domain";
import { extractLinks } from "@/lib/extract";
import { getRobotsForDomain, robotsUrlAllows } from "@/lib/robots";
import { parseUrlStrict, safeFetch, SsrfError } from "@/lib/ssrf";
import { MAX_SITEMAP_URLS, fetchSitemapUrls } from "./sitemap";
import type { Database } from "@/lib/supabase/types";

export interface ProbeResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  statusCode?: number;
  reachable: boolean;
  rootDomain?: string;
  robots: {
    checked: boolean;
    allowed: boolean;
    hasRobotsTxt: boolean;
  };
  sameOriginLinkCount: number;
  sitemap: {
    found: boolean;
    urlCount: number;
  };
  error?: string;
}

export async function probeUrl(
  supabase: SupabaseClient<Database>,
  rawUrl: string,
  userAgent: string,
  botToken: string
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = parseUrlStrict(rawUrl);
  } catch (err) {
    return {
      ok: false,
      url: rawUrl,
      reachable: false,
      robots: { checked: false, allowed: false, hasRobotsTxt: false },
      sameOriginLinkCount: 0,
      sitemap: { found: false, urlCount: 0 },
      error: err instanceof SsrfError ? err.message : "Invalid URL",
    };
  }

  const rootDomain = getRegistrableDomain(parsed.hostname);
  const origin = `${parsed.protocol}//${parsed.host}`;

  let statusCode: number | undefined;
  let finalUrl: string | undefined;
  let html = "";
  let reachable = false;

  try {
    const res = await safeFetch(parsed.href, { method: "GET", userAgent });
    statusCode = res.status;
    finalUrl = res.finalUrl;
    reachable = res.status >= 200 && res.status < 400;
    const contentType = String(res.headers["content-type"] ?? "");
    if (contentType.includes("html") || contentType === "") {
      html = res.body.toString("utf-8");
    }
  } catch (err) {
    return {
      ok: false,
      url: rawUrl,
      reachable: false,
      rootDomain,
      robots: { checked: false, allowed: false, hasRobotsTxt: false },
      sameOriginLinkCount: 0,
      sitemap: { found: false, urlCount: 0 },
      error: err instanceof Error ? err.message : "Fetch failed",
    };
  }

  let robotsAllowed = true;
  let hasRobotsTxt = false;
  let robotsChecked = false;
  try {
    const robots = await getRobotsForDomain(supabase, origin, userAgent, botToken);
    robotsAllowed = robotsUrlAllows(robots, botToken, parsed);
    hasRobotsTxt = robots.parsed.groups.length > 0;
    robotsChecked = true;
  } catch {
    robotsChecked = false;
  }

  const sameOriginLinkCount = html ? extractLinks(html, parsed.href).length : 0;

  let sitemapFound = false;
  let sitemapUrlCount = 0;
  try {
    const sitemapUrls = await fetchSitemapUrls(`${origin}/sitemap.xml`, userAgent);
    sitemapFound = sitemapUrls.length > 0;
    sitemapUrlCount = Math.min(sitemapUrls.length, MAX_SITEMAP_URLS);
  } catch {
    sitemapFound = false;
  }

  return {
    ok: true,
    url: rawUrl,
    finalUrl,
    statusCode,
    reachable,
    rootDomain,
    robots: { checked: robotsChecked, allowed: robotsAllowed, hasRobotsTxt },
    sameOriginLinkCount,
    sitemap: { found: sitemapFound, urlCount: sitemapUrlCount },
  };
}
