/**
 * Pure, deterministic HTML → {Markdown, assets, links} extraction. No AI,
 * no third-party service — cheerio for DOM traversal, a small
 * Readability-style boilerplate-stripping heuristic to find the main
 * content block, and Turndown for HTML → Markdown.
 */
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import TurndownService from "turndown";
import { getRegistrableDomain } from "./domain";
import type { AssetType } from "./constants";

// ---------------------------------------------------------------------------
// Boilerplate stripping + main-content extraction
// ---------------------------------------------------------------------------

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "svg",
  "button",
  "input",
  "select",
  "textarea",
  "link",
  "meta",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".advertisement",
  ".ads",
  ".cookie-banner",
  ".newsletter-signup",
];

const SCORABLE_TAGS = new Set(["p", "pre", "blockquote", "li", "td"]);

/** Cheerio's own element type in v1, aliased for readability. */
type CheerioEl = AnyNode;

function scoreDocument($: cheerio.CheerioAPI): Map<CheerioEl, number> {
  const scores = new Map<CheerioEl, number>();

  const bump = (el: CheerioEl | undefined, amount: number) => {
    if (!el) return;
    scores.set(el, (scores.get(el) ?? 0) + amount);
  };

  $("body")
    .find("*")
    .each((_i, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase();
      if (!tag || !SCORABLE_TAGS.has(tag)) return;

      const text = $(el).text().trim();
      if (text.length < 25) return;

      // Commas are a decent signal of prose vs. boilerplate/nav lists.
      const commaBonus = (text.match(/,/g) ?? []).length;
      const baseScore = Math.min(Math.floor(text.length / 50), 8) + commaBonus;

      const parent = $(el).parent().get(0);
      const grandparent = $(el).parent().parent().get(0);

      bump(parent, baseScore);
      bump(grandparent, baseScore / 2);
    });

  return scores;
}

function pickMainElement($: cheerio.CheerioAPI): cheerio.Cheerio<CheerioEl> {
  const semanticMain = $("main, article").first();
  const scores = scoreDocument($);

  let best: CheerioEl | null = null;
  let bestScore = -Infinity;
  for (const [el, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (semanticMain.length > 0) {
    const semanticScore = scores.get(semanticMain.get(0) as CheerioEl) ?? 0;
    // Trust <main>/<article> unless the heuristic found something with
    // meaningfully more scored content inside it (e.g. <main> is just a
    // thin wrapper and the real prose lives in a sibling <div>).
    if (semanticScore >= bestScore * 0.5 || !best) {
      return semanticMain;
    }
  }

  if (best) return $(best);
  return $("body");
}

export interface ExtractedContent {
  title: string;
  markdown: string;
  wordCount: number;
}

function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return service;
}

export function extractMainContent(html: string, url: string): ExtractedContent {
  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    url;

  $(REMOVE_SELECTORS.join(",")).remove();

  const main = pickMainElement($);
  const html2 = main.html() ?? "";

  const service = turndown();
  let markdown = "";
  try {
    markdown = service.turndown(html2).trim();
  } catch {
    markdown = main.text().trim();
  }

  const wordCount = markdown.length === 0 ? 0 : markdown.split(/\s+/).filter(Boolean).length;

  return { title, markdown, wordCount };
}

// ---------------------------------------------------------------------------
// Asset extraction (registry only — URLs, never bytes)
// ---------------------------------------------------------------------------

export interface ExtractedAsset {
  type: AssetType;
  url: string;
  altText?: string;
  mimeType?: string;
}

export interface ExtractedAssets {
  images: ExtractedAsset[];
  videos: ExtractedAsset[];
  videoEmbeds: ExtractedAsset[];
}

const EMBED_ALLOWLIST: Array<{ name: string; test: (hostname: string) => boolean }> = [
  { name: "youtube", test: (h) => h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtube-nocookie.com" || h.endsWith(".youtube-nocookie.com") },
  { name: "vimeo", test: (h) => h === "vimeo.com" || h.endsWith(".vimeo.com") },
  { name: "loom", test: (h) => h === "loom.com" || h.endsWith(".loom.com") },
];

function isAllowlistedEmbed(url: URL): boolean {
  return EMBED_ALLOWLIST.some((entry) => entry.test(url.hostname.toLowerCase()));
}

function resolveUrl(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

function firstSrcsetCandidate(srcset: string | undefined, base: string): string | null {
  if (!srcset) return null;
  const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return resolveUrl(first, base);
}

export function extractAssets(html: string, url: string): ExtractedAssets {
  const $ = cheerio.load(html);

  const images = new Map<string, ExtractedAsset>();
  const videos = new Map<string, ExtractedAsset>();
  const videoEmbeds = new Map<string, ExtractedAsset>();

  $("img").each((_i, el) => {
    const $el = $(el);
    const src = resolveUrl($el.attr("src"), url) ?? firstSrcsetCandidate($el.attr("srcset"), url);
    if (!src) return;
    images.set(src, { type: "image", url: src, altText: $el.attr("alt")?.trim() || undefined });
  });

  const ogImage = resolveUrl($("meta[property='og:image']").attr("content"), url);
  if (ogImage && !images.has(ogImage)) {
    images.set(ogImage, { type: "image", url: ogImage, altText: "Open Graph image" });
  }

  $("video").each((_i, el) => {
    const $el = $(el);
    const directSrc = resolveUrl($el.attr("src"), url);
    if (directSrc) {
      videos.set(directSrc, { type: "video", url: directSrc, mimeType: $el.attr("type") ?? undefined });
    }
    $el.find("source").each((_j, sourceEl) => {
      const $source = $(sourceEl);
      const src = resolveUrl($source.attr("src"), url);
      if (!src) return;
      videos.set(src, { type: "video", url: src, mimeType: $source.attr("type") ?? undefined });
    });
  });

  $("iframe").each((_i, el) => {
    const $el = $(el);
    const src = resolveUrl($el.attr("src"), url);
    if (!src) return;
    let parsed: URL;
    try {
      parsed = new URL(src);
    } catch {
      return;
    }
    if (isAllowlistedEmbed(parsed)) {
      videoEmbeds.set(src, { type: "video_embed", url: src, altText: $el.attr("title")?.trim() || undefined });
    }
  });

  return {
    images: Array.from(images.values()),
    videos: Array.from(videos.values()),
    videoEmbeds: Array.from(videoEmbeds.values()),
  };
}

// ---------------------------------------------------------------------------
// Link extraction (same-registrable-domain, normalized, deduped)
// ---------------------------------------------------------------------------

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_EXACT = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "igshid",
  "yclid",
  "_ga",
  "_gl",
]);

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";

  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAM_EXACT.has(lower) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
      toDelete.push(key);
    }
  }
  toDelete.forEach((key) => url.searchParams.delete(key));

  // Normalize trailing slash on bare paths (but not the root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.hostname = url.hostname.toLowerCase();

  const sortedParams = new URLSearchParams(Array.from(url.searchParams.entries()).sort());
  url.search = sortedParams.toString() ? `?${sortedParams.toString()}` : "";

  return url.href;
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const baseDomain = getRegistrableDomain(base.hostname);

  const seen = new Set<string>();
  const results: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return;

    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (getRegistrableDomain(parsed.hostname) !== baseDomain) return;

    const normalized = normalizeUrl(parsed.href);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}
