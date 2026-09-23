import { describe, expect, it } from "vitest";
import { extractAssets, extractLinks, extractMainContent, normalizeUrl } from "./extract";

const ARTICLE_HTML = `
<!doctype html>
<html>
<head><title>The Article Title</title></head>
<body>
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <aside class="sidebar"><p>Sponsored links and other junk that should not count, this is filler filler filler.</p></aside>
  <main>
    <article>
      <h1>The Article Title</h1>
      <p>This is the first real paragraph of the article, with enough length and, commas, to score well against the boilerplate around it.</p>
      <p>This is the second real paragraph, continuing the actual content of the page, again with enough text and punctuation to score highly.</p>
      <p>A third meaningful paragraph rounds out the main content block, making it clearly the largest scored region on this page.</p>
    </article>
  </main>
  <footer><p>Copyright 2024. All rights reserved. Contact us. Privacy policy. Terms.</p></footer>
  <script>console.log("tracking pixel junk");</script>
</body>
</html>
`;

const ASSETS_HTML = `
<!doctype html>
<html>
<head>
  <meta property="og:image" content="/og-cover.png" />
</head>
<body>
  <img src="/images/photo1.jpg" alt="Photo one" />
  <img srcset="/images/photo2-small.jpg 480w, /images/photo2-large.jpg 1024w" alt="Photo two" />
  <img src="data:image/png;base64,AAAA" alt="inline data uri, should be skipped" />
  <video>
    <source src="/videos/clip.mp4" type="video/mp4" />
    <source src="/videos/clip.webm" type="video/webm" />
  </video>
  <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="A YouTube video"></iframe>
  <iframe src="https://player.vimeo.com/video/12345" title="A Vimeo video"></iframe>
  <iframe src="https://www.loom.com/embed/abc123" title="A Loom recording"></iframe>
  <iframe src="https://evil-tracker.example.com/embed/x" title="not allowlisted"></iframe>
</body>
</html>
`;

const LINKS_HTML = `
<!doctype html>
<html>
<body>
  <a href="/page-one">Page one</a>
  <a href="/page-two?utm_source=newsletter&ref=abc&keep=1">Page two with tracking params</a>
  <a href="https://blog.example.com/subdomain-page">Subdomain, still same registrable domain</a>
  <a href="https://external-site.com/other">External, should be excluded</a>
  <a href="/page-one#fragment-should-be-stripped">Duplicate of page one via fragment</a>
  <a href="mailto:hello@example.com">Not http(s), excluded</a>
  <a href="/page-one/">Trailing slash duplicate of page one</a>
</body>
</html>
`;

describe("extractMainContent", () => {
  const result = extractMainContent(ARTICLE_HTML, "https://example.com/article");

  it("extracts the page title", () => {
    expect(result.title).toBe("The Article Title");
  });

  it("keeps the main article paragraphs", () => {
    expect(result.markdown).toContain("first real paragraph");
    expect(result.markdown).toContain("second real paragraph");
    expect(result.markdown).toContain("third meaningful paragraph");
  });

  it("strips nav/header/footer/aside/script boilerplate", () => {
    expect(result.markdown).not.toContain("Sponsored links");
    expect(result.markdown).not.toContain("Copyright 2024");
    expect(result.markdown).not.toContain("tracking pixel junk");
    expect(result.markdown).not.toContain("Home");
  });

  it("computes a plausible word count", () => {
    expect(result.wordCount).toBeGreaterThan(20);
  });
});

describe("extractAssets", () => {
  const result = extractAssets(ASSETS_HTML, "https://example.com/gallery");

  it("resolves <img src> to an absolute URL", () => {
    expect(result.images.some((i) => i.url === "https://example.com/images/photo1.jpg")).toBe(true);
  });

  it("picks a candidate from srcset", () => {
    expect(result.images.some((i) => i.url === "https://example.com/images/photo2-small.jpg")).toBe(true);
  });

  it("skips data: URIs", () => {
    expect(result.images.some((i) => i.url.startsWith("data:"))).toBe(false);
  });

  it("includes the og:image as a fallback candidate", () => {
    expect(result.images.some((i) => i.url === "https://example.com/og-cover.png")).toBe(true);
  });

  it("resolves <video><source> elements to absolute direct-file URLs", () => {
    expect(result.videos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://example.com/videos/clip.mp4" }),
        expect.objectContaining({ url: "https://example.com/videos/clip.webm" }),
      ])
    );
  });

  it("matches allowlisted embed providers only", () => {
    const urls = result.videoEmbeds.map((e) => e.url);
    expect(urls).toContain("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(urls).toContain("https://player.vimeo.com/video/12345");
    expect(urls).toContain("https://www.loom.com/embed/abc123");
    expect(urls.some((u) => u.includes("evil-tracker"))).toBe(false);
  });
});

describe("extractLinks", () => {
  const links = extractLinks(LINKS_HTML, "https://example.com/start");

  it("resolves relative links to absolute URLs", () => {
    expect(links).toContain("https://example.com/page-one");
  });

  it("includes same-registrable-domain subdomains", () => {
    expect(links).toContain("https://blog.example.com/subdomain-page");
  });

  it("excludes links to a different registrable domain", () => {
    expect(links.some((l) => l.includes("external-site.com"))).toBe(false);
  });

  it("excludes non-http(s) links", () => {
    expect(links.some((l) => l.startsWith("mailto:"))).toBe(false);
  });

  it("strips known tracking params but keeps others", () => {
    const match = links.find((l) => l.startsWith("https://example.com/page-two"));
    expect(match).toBeDefined();
    expect(match).not.toContain("utm_source");
    expect(match).not.toContain("ref=");
    expect(match).toContain("keep=1");
  });

  it("dedupes fragment- and trailing-slash-only variants", () => {
    const pageOneOccurrences = links.filter((l) => l === "https://example.com/page-one");
    expect(pageOneOccurrences).toHaveLength(1);
  });
});

describe("normalizeUrl", () => {
  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://EXAMPLE.com/a")).toBe("https://example.com/a");
  });

  it("removes a trailing slash on non-root paths", () => {
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
  });

  it("keeps the root path as /", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });
});
