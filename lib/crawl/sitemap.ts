/**
 * sitemap.xml discovery — used by the pre-run probe and to seed
 * `crawl_queue` for scope='site'. Handles one level of sitemap-index
 * nesting. Bounded so a malicious/huge sitemap can't blow up the job.
 */
import * as cheerio from "cheerio";
import { safeFetch } from "@/lib/ssrf";

export const MAX_SITEMAP_URLS = 500;
const MAX_NESTED_SITEMAPS = 5;
const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;

export interface ParsedSitemap {
  urls: string[];
  nestedSitemaps: string[];
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $("urlset > url > loc").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) urls.push(text);
  });

  const nestedSitemaps: string[] = [];
  $("sitemapindex > sitemap > loc").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) nestedSitemaps.push(text);
  });

  return { urls, nestedSitemaps };
}

export async function fetchSitemapUrls(
  sitemapUrl: string,
  userAgent: string,
  depth = 0
): Promise<string[]> {
  if (depth > 1) return [];
  try {
    const res = await safeFetch(sitemapUrl, {
      userAgent,
      timeoutMs: 8000,
      maxResponseBytes: MAX_SITEMAP_BYTES,
    });
    if (res.status < 200 || res.status >= 300) return [];

    const { urls, nestedSitemaps } = parseSitemapXml(res.body.toString("utf-8"));
    let all = urls.slice(0, MAX_SITEMAP_URLS);

    if (all.length < MAX_SITEMAP_URLS && depth === 0) {
      for (const nested of nestedSitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
        const nestedUrls = await fetchSitemapUrls(nested, userAgent, depth + 1);
        all = all.concat(nestedUrls).slice(0, MAX_SITEMAP_URLS);
      }
    }

    return all;
  } catch {
    return [];
  }
}
