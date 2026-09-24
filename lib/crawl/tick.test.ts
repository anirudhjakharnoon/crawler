import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FakeSupabase, type Row } from "@/lib/testing/fakeSupabase";
import { processTickBatch } from "./tick";

vi.mock("@/lib/ssrf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ssrf")>("@/lib/ssrf");
  return { ...actual, safeFetch: vi.fn() };
});
vi.mock("@/lib/render", () => ({ renderPage: vi.fn() }));

import { safeFetch } from "@/lib/ssrf";
import { renderPage } from "@/lib/render";

const PAGE_HTML = `
<!doctype html>
<html>
<head><title>Integration Fixture Page</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <article>
      <h1>Integration Fixture Page</h1>
      <p>This paragraph exists purely to give the extractor something substantial and comma-containing, richly-worded, prose-like to score as the main content block.</p>
      <p>A second paragraph continues the same theme, again long enough and punctuated enough to clearly outscore the header and footer boilerplate around it.</p>
    </article>
  </main>
  <img src="/hero.jpg" alt="Hero image" />
  <video><source src="/clip.mp4" type="video/mp4" /></video>
  <iframe src="https://www.youtube.com/embed/abc123" title="Demo video"></iframe>
  <footer><p>Site footer copyright text that should not appear in extracted markdown.</p></footer>
</body>
</html>
`;

function makeFakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers,
    finalUrl: "unused",
    body: Buffer.from(body, "utf-8"),
    truncated: false,
    redirectChain: [],
  };
}

function buildJobFixture(overrides: Partial<Row> = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    owner: "owner-1",
    created_at: now,
    target_url: "https://example.com/",
    root_domain: "example.com",
    scope: "page",
    content_types: ["text", "images", "video"],
    status: "running",
    max_pages: 500,
    max_depth: 0,
    rate_limit_rps: 3,
    pages_crawled: 0,
    pages_skipped: 0,
    pages_errored: 0,
    images_found: 0,
    videos_found: 0,
    text_bytes: 0,
    robots_disallowed: 0,
    started_at: now,
    finished_at: null,
    last_ticked_at: null,
    error_message: null,
    md_storage_path: null,
    md_size_bytes: null,
    ...overrides,
  };
}

const SHELL_HTML = `
<!doctype html>
<html>
<head><title>SPA Shell</title></head>
<body class="body"><div id="container"></div>
<script>window.addEventListener('DOMContentLoaded', function() { renderApp(); });</script>
</body>
</html>
`;

const RENDERED_HTML = `
<!doctype html>
<html>
<head><title>SPA Shell</title></head>
<body>
  <main>
    <article>
      <h1>Rendered Article</h1>
      <p>This paragraph only exists once the page's own client-side JavaScript has actually run and populated the DOM with real, substantial, comma-containing prose content for the extractor to find.</p>
      <p>A second paragraph keeps this comfortably above the render-fallback word-count threshold so the test is unambiguous either way.</p>
    </article>
  </main>
</body>
</html>
`;

describe("processTickBatch (integration, mocked fetch)", () => {
  const originalEnableRendering = process.env.ENABLE_JS_RENDERING;

  beforeEach(() => {
    vi.mocked(safeFetch).mockReset();
    vi.mocked(renderPage).mockReset();
    delete process.env.ENABLE_JS_RENDERING;
  });

  afterEach(() => {
    if (originalEnableRendering === undefined) {
      delete process.env.ENABLE_JS_RENDERING;
    } else {
      process.env.ENABLE_JS_RENDERING = originalEnableRendering;
    }
  });

  it("crawls a single page (scope='page'), extracts text+images+video, and assembles the export", async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return makeFakeResponse(200, "User-agent: *\nAllow: /\n", { "content-type": "text/plain" });
      }
      if (url === "https://example.com/") {
        return makeFakeResponse(200, PAGE_HTML, { "content-type": "text/html; charset=utf-8" });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const fake = new FakeSupabase(
      {
        crawl_jobs: [buildJobFixture()],
        crawl_queue: [
          {
            id: 1,
            job_id: "job-1",
            url: "https://example.com/",
            normalized_url: "https://example.com/",
            depth: 0,
            status: "pending",
            discovered_from: null,
            http_status: null,
            skip_reason: null,
            fetched_at: null,
          },
        ],
      },
      { robots_cache: "domain", job_rate_limits: "owner" }
    );

    const client = fake as any;

    const result = await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0 (+https://crawlr.example/about-crawlr)",
      botToken: "CrawlrBot",
      sleep: async () => {},
    });

    expect(result.frontierEmpty).toBe(true);
    expect(result.jobStatus).toBe("completed");
    expect(result.capped).toBe(false);
    expect(result.processedCount).toBe(1);

    const pages = fake.getTable("crawl_pages");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Integration Fixture Page");
    expect(String(pages[0]?.markdown)).toContain("purely to give the extractor");
    expect(String(pages[0]?.markdown)).not.toContain("Site footer copyright");

    const assets = fake.getTable("crawl_assets");
    const images = assets.filter((a) => a.asset_type === "image");
    const videos = assets.filter((a) => a.asset_type === "video");
    const embeds = assets.filter((a) => a.asset_type === "video_embed");
    expect(images).toEqual([
      expect.objectContaining({ asset_url: "https://example.com/hero.jpg" }),
    ]);
    expect(videos).toEqual([
      expect.objectContaining({ asset_url: "https://example.com/clip.mp4" }),
    ]);
    expect(embeds).toEqual([
      expect.objectContaining({ asset_url: "https://www.youtube.com/embed/abc123" }),
    ]);

    const queueRows = fake.getTable("crawl_queue");
    expect(queueRows[0]?.status).toBe("done");
    expect(queueRows[0]?.http_status).toBe(200);

    const jobs = fake.getTable("crawl_jobs");
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.pages_crawled).toBe(1);
    expect(jobs[0]?.md_storage_path).toBe("job-1/output.md");
    expect(Number(jobs[0]?.md_size_bytes)).toBeGreaterThan(0);

    const events = fake.getTable("crawl_events");
    expect(events.some((e) => e.kind === "fetch")).toBe(true);
    expect(events.some((e) => e.kind === "done")).toBe(true);

    const uploaded = fake.uploadedFiles.get("exports/job-1/output.md");
    expect(uploaded).toBeDefined();
    const markdown = uploaded?.toString("utf-8") ?? "";
    expect(markdown).toContain("# CRAWLR export");
    expect(markdown).toContain("Integration Fixture Page");
    expect(markdown).toContain("purely to give the extractor");
  });

  it("skips a robots-disallowed page without fetching it", async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return makeFakeResponse(200, "User-agent: *\nDisallow: /\n", { "content-type": "text/plain" });
      }
      throw new Error(`Should not fetch a disallowed page: ${url}`);
    });

    const fake = new FakeSupabase(
      {
        crawl_jobs: [buildJobFixture()],
        crawl_queue: [
          {
            id: 1,
            job_id: "job-1",
            url: "https://example.com/",
            normalized_url: "https://example.com/",
            depth: 0,
            status: "pending",
            discovered_from: null,
            http_status: null,
            skip_reason: null,
            fetched_at: null,
          },
        ],
      },
      { robots_cache: "domain", job_rate_limits: "owner" }
    );

    const client = fake as any;
    const result = await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0 (+https://crawlr.example/about-crawlr)",
      botToken: "CrawlrBot",
      sleep: async () => {},
    });

    expect(result.jobStatus).toBe("completed");
    const queueRows = fake.getTable("crawl_queue");
    expect(queueRows[0]?.status).toBe("skipped");
    expect(queueRows[0]?.skip_reason).toBe("robots");

    const jobs = fake.getTable("crawl_jobs");
    expect(jobs[0]?.pages_skipped).toBe(1);
    expect(jobs[0]?.robots_disallowed).toBe(1);
  });

  it("falls back to headless rendering when static HTML looks like a JS shell and ENABLE_JS_RENDERING is set", async () => {
    process.env.ENABLE_JS_RENDERING = "true";

    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return makeFakeResponse(200, "User-agent: *\nAllow: /\n", { "content-type": "text/plain" });
      }
      if (url === "https://example.com/") {
        return makeFakeResponse(200, SHELL_HTML, { "content-type": "text/html; charset=utf-8" });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.mocked(renderPage).mockResolvedValue({ html: RENDERED_HTML, finalUrl: "https://example.com/" });

    const fake = new FakeSupabase(
      {
        crawl_jobs: [buildJobFixture({ content_types: ["text"] })],
        crawl_queue: [
          {
            id: 1,
            job_id: "job-1",
            url: "https://example.com/",
            normalized_url: "https://example.com/",
            depth: 0,
            status: "pending",
            discovered_from: null,
            http_status: null,
            skip_reason: null,
            fetched_at: null,
          },
        ],
      },
      { robots_cache: "domain", job_rate_limits: "owner" }
    );

    const client = fake as any;
    const result = await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0 (+https://crawlr.example/about-crawlr)",
      botToken: "CrawlrBot",
      sleep: async () => {},
    });

    expect(result.jobStatus).toBe("completed");
    expect(renderPage).toHaveBeenCalledWith("https://example.com/", "CrawlrBot/1.0 (+https://crawlr.example/about-crawlr)");

    const pages = fake.getTable("crawl_pages");
    expect(pages).toHaveLength(1);
    expect(String(pages[0]?.markdown)).toContain("only exists once the page's own client-side JavaScript has actually run");

    const events = fake.getTable("crawl_events");
    expect(events.some((e) => e.kind === "extract" && String(e.message).includes("headless rendering"))).toBe(true);
  });

  it("keeps the static HTML and logs a warning if the rendering fallback itself throws", async () => {
    process.env.ENABLE_JS_RENDERING = "true";

    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return makeFakeResponse(200, "User-agent: *\nAllow: /\n", { "content-type": "text/plain" });
      }
      if (url === "https://example.com/") {
        return makeFakeResponse(200, SHELL_HTML, { "content-type": "text/html; charset=utf-8" });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.mocked(renderPage).mockRejectedValue(new Error("browser launch failed"));

    const fake = new FakeSupabase(
      {
        crawl_jobs: [buildJobFixture({ content_types: ["text"] })],
        crawl_queue: [
          {
            id: 1,
            job_id: "job-1",
            url: "https://example.com/",
            normalized_url: "https://example.com/",
            depth: 0,
            status: "pending",
            discovered_from: null,
            http_status: null,
            skip_reason: null,
            fetched_at: null,
          },
        ],
      },
      { robots_cache: "domain", job_rate_limits: "owner" }
    );

    const client = fake as any;
    const result = await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0",
      botToken: "CrawlrBot",
      sleep: async () => {},
    });

    expect(result.jobStatus).toBe("completed");
    const events = fake.getTable("crawl_events");
    expect(
      events.some((e) => e.kind === "extract" && String(e.message).includes("JS-rendering fallback failed"))
    ).toBe(true);
    // Tick still completes the page using whatever the static shell gave us, rather than erroring the whole row out.
    const queueRows = fake.getTable("crawl_queue");
    expect(queueRows[0]?.status).toBe("done");
  });

  it("does not attempt headless rendering when ENABLE_JS_RENDERING is unset, even for shell-like HTML", async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return makeFakeResponse(200, "User-agent: *\nAllow: /\n", { "content-type": "text/plain" });
      }
      if (url === "https://example.com/") {
        return makeFakeResponse(200, SHELL_HTML, { "content-type": "text/html; charset=utf-8" });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const fake = new FakeSupabase(
      {
        crawl_jobs: [buildJobFixture({ content_types: ["text"] })],
        crawl_queue: [
          {
            id: 1,
            job_id: "job-1",
            url: "https://example.com/",
            normalized_url: "https://example.com/",
            depth: 0,
            status: "pending",
            discovered_from: null,
            http_status: null,
            skip_reason: null,
            fetched_at: null,
          },
        ],
      },
      { robots_cache: "domain", job_rate_limits: "owner" }
    );

    const client = fake as any;
    await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0",
      botToken: "CrawlrBot",
      sleep: async () => {},
    });

    expect(renderPage).not.toHaveBeenCalled();
  });

  it("is a no-op if the job isn't in 'running' status", async () => {
    const fake = new FakeSupabase({
      crawl_jobs: [buildJobFixture({ status: "aborted" })],
      crawl_queue: [],
    });
    const client = fake as any;
    const result = await processTickBatch(client, "job-1", {
      userAgent: "CrawlrBot/1.0",
      botToken: "CrawlrBot",
    });
    expect(result.jobStatus).toBe("aborted");
    expect(result.processedCount).toBe(0);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
