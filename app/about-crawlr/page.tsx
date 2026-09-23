import type { Metadata } from "next";
import { BOT_NAME, BOT_VERSION, DEFAULT_MAX_DEPTH, DEFAULT_MAX_PAGES, DEFAULT_RATE_LIMIT_RPS, HARD_MAX_RATE_LIMIT_RPS } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About CrawlrBot — CRAWLR",
  description: "What CrawlrBot is, how it behaves, and how to block it.",
};

export default function AboutCrawlrPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm leading-relaxed text-ac/80">
      <h1 className="mb-6 font-display text-2xl font-bold uppercase tracking-[0.15em] text-ac">
        About {BOT_NAME}
      </h1>

      <p className="mb-4">
        <span className="text-ac">{BOT_NAME}/{BOT_VERSION}</span> is the automated crawler behind{" "}
        <strong>CRAWLR</strong>, a URL → Text / Images / Video extraction tool. It fetches
        publicly reachable, non-authenticated HTML pages on behalf of a user who has confirmed
        they have the right to crawl the target, and extracts structured content using
        deterministic, rule-based HTML parsing — no JavaScript rendering, no AI/LLM calls, no
        third-party scraping services.
      </p>

      <h2 className="mb-2 mt-8 font-display text-base uppercase tracking-[0.1em] text-ac">
        How it behaves
      </h2>
      <ul className="mb-4 list-inside list-disc space-y-1">
        <li>Fetches and honors <code>robots.txt</code> before queuing any URL on a domain.</li>
        <li>
          Rate-limits itself per domain (default {DEFAULT_RATE_LIMIT_RPS} requests/second, hard-capped
          server-side at {HARD_MAX_RATE_LIMIT_RPS} req/s regardless of configuration).
        </li>
        <li>Never bypasses logins, paywalls, or CAPTCHAs, and never spoofs headers.</li>
        <li>Never re-hosts images or video — it links back to the original source, always.</li>
        <li>Caps itself at {DEFAULT_MAX_PAGES} pages and depth {DEFAULT_MAX_DEPTH} per run by default.</li>
        <li>Identifies itself honestly via this exact User-Agent string on every request.</li>
      </ul>

      <h2 className="mb-2 mt-8 font-display text-base uppercase tracking-[0.1em] text-ac">
        How to block it
      </h2>
      <p className="mb-4">
        Add the following to your <code>robots.txt</code> to disallow {BOT_NAME} specifically:
      </p>
      <pre className="mb-4 overflow-x-auto rounded-sm border border-ac/15 bg-black/40 p-3 text-xs text-ac/70">
{`User-agent: ${BOT_NAME}
Disallow: /`}
      </pre>
      <p>
        {BOT_NAME} re-checks each domain&apos;s <code>robots.txt</code> at most once every 24 hours,
        so a change here will take effect on its next fetch of your site.
      </p>
    </main>
  );
}
