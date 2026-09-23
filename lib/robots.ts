/**
 * robots.txt fetching, parsing, per-domain caching (`robots_cache`, 24h TTL)
 * and Allow/Disallow evaluation. Every crawl fetch must be checked against
 * this before the URL is queued or fetched — disallowed URLs are only ever
 * logged as skipped, never fetched.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ROBOTS_CACHE_TTL_MS } from "./constants";
import { safeFetch, SsrfError } from "./ssrf";
import type { Database } from "./supabase/types";

export interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsGroup {
  userAgents: string[]; // lowercased product tokens, "*" included verbatim
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

const FIELD_LINE = /^([A-Za-z-]+)\s*:\s*(.*)$/;

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let currentUAs: string[] = [];
  let currentRules: RobotsRule[] = [];
  let lastWasUA = false;

  const flush = () => {
    if (currentUAs.length > 0) {
      groups.push({ userAgents: currentUAs, rules: currentRules });
    }
    currentUAs = [];
    currentRules = [];
  };

  const lines = text.split(/\r\n|\r|\n/);
  for (const rawLine of lines) {
    const withoutComment = rawLine.split("#")[0] ?? "";
    const line = withoutComment.trim();
    if (!line) continue;

    const match = FIELD_LINE.exec(line);
    if (!match) continue;
    const field = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();

    if (field === "user-agent") {
      if (!lastWasUA) {
        flush();
      }
      currentUAs.push(value.toLowerCase());
      lastWasUA = true;
    } else if (field === "allow" || field === "disallow") {
      currentRules.push({ type: field, pattern: value });
      lastWasUA = false;
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
      lastWasUA = false;
    } else {
      lastWasUA = false;
    }
  }
  flush();

  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  escaped = escaped.replace(/\*/g, ".*");
  if (escaped.endsWith("\\$")) {
    escaped = `${escaped.slice(0, -2)}$`;
  }
  return new RegExp(`^${escaped}`);
}

function selectGroup(groups: RobotsGroup[], botToken: string): RobotsGroup | null {
  const token = botToken.toLowerCase();
  const exact = groups.find((g) => g.userAgents.includes(token));
  if (exact) return exact;
  return groups.find((g) => g.userAgents.includes("*")) ?? null;
}

/**
 * `pathAndQuery` should be the request-target form, e.g. "/blog/post?x=1".
 */
export function isAllowedPath(parsed: ParsedRobots, botToken: string, pathAndQuery: string): boolean {
  const group = selectGroup(parsed.groups, botToken);
  if (!group) return true;

  let bestLen = -1;
  let bestType: "allow" | "disallow" = "allow";

  for (const rule of group.rules) {
    if (rule.type === "disallow" && rule.pattern === "") continue;
    const regex = patternToRegex(rule.pattern);
    if (!regex.test(pathAndQuery)) continue;
    const len = rule.pattern.length;
    if (len > bestLen || (len === bestLen && rule.type === "allow")) {
      bestLen = len;
      bestType = rule.type;
    }
  }

  if (bestLen === -1) return true;
  return bestType === "allow";
}

export interface RobotsForDomain {
  parsed: ParsedRobots;
  sitemapUrls: string[];
  fromCache: boolean;
}

/**
 * Loads robots.txt for `domain` (scheme + host, e.g. "https://example.com"),
 * consulting/populating `robots_cache` first. A fetch failure (network
 * error, 404, etc.) is treated as "no robots.txt" => allow-all, matching
 * standard crawler behavior, and is cached too (so we don't hammer a domain
 * that has none).
 */
export async function getRobotsForDomain(
  supabase: SupabaseClient<Database>,
  domain: string,
  userAgent: string,
  botToken: string
): Promise<RobotsForDomain> {
  const nowIso = new Date().toISOString();

  const { data: cached } = await supabase
    .from("robots_cache")
    .select("*")
    .eq("domain", domain)
    .maybeSingle();

  if (cached && cached.expires_at > nowIso) {
    const parsed = parseRobotsTxt(cached.robots_txt ?? "");
    return { parsed, sitemapUrls: cached.sitemap_urls ?? [], fromCache: true };
  }

  let robotsText = "";
  let sitemapUrls: string[] = [];

  try {
    const res = await safeFetch(`${domain}/robots.txt`, {
      method: "GET",
      userAgent,
      timeoutMs: 8000,
      maxResponseBytes: 512 * 1024,
    });
    if (res.status >= 200 && res.status < 300) {
      robotsText = res.body.toString("utf-8");
      sitemapUrls = parseRobotsTxt(robotsText).sitemaps;
    }
    // 4xx/5xx => no robots.txt => allow-all (robotsText stays "").
  } catch (err) {
    // SSRF rejection or network failure => be conservative and disallow
    // nothing we can't verify: treat as "no robots.txt found" (allow-all),
    // since we still enforce our own caps/politeness independently. Log by
    // rethrowing SsrfError only if the *original* domain itself is unsafe —
    // callers already validated the domain before getting here, so this is
    // just network flakiness.
    if (err instanceof SsrfError && err.code === "blocked_ip") {
      throw err;
    }
    robotsText = "";
    sitemapUrls = [];
  }

  const expiresAt = new Date(Date.now() + ROBOTS_CACHE_TTL_MS).toISOString();
  await supabase.from("robots_cache").upsert({
    domain,
    robots_txt: robotsText,
    sitemap_urls: sitemapUrls,
    fetched_at: nowIso,
    expires_at: expiresAt,
  });

  return { parsed: parseRobotsTxt(robotsText), sitemapUrls, fromCache: false };
}

export function robotsUrlAllows(robots: RobotsForDomain, botToken: string, url: URL): boolean {
  return isAllowedPath(robots.parsed, botToken, `${url.pathname}${url.search}` || "/");
}
