/**
 * Assembles every crawled page's Markdown into a single ordered document:
 * a top-level header (source URL, crawl date, scope) followed by one
 * `## <title>` section per page, in the order pages were fetched.
 */
import type { CrawlPageRow } from "@/lib/supabase/types";
import type { Scope } from "@/lib/constants";

export interface AssembleInput {
  targetUrl: string;
  scope: Scope;
  crawledAt: Date;
  pages: Pick<CrawlPageRow, "url" | "title" | "markdown" | "fetched_at">[];
}

export function assembleMarkdownDocument(input: AssembleInput): string {
  const { targetUrl, scope, crawledAt, pages } = input;

  const header = [
    `# CRAWLR export`,
    ``,
    `- **Source:** ${targetUrl}`,
    `- **Scope:** ${scope}`,
    `- **Crawled:** ${crawledAt.toISOString()}`,
    `- **Pages:** ${pages.length}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const sorted = [...pages].sort(
    (a, b) => new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime()
  );

  const sections = sorted.map((page) => {
    const title = page.title?.trim() || page.url;
    const body = page.markdown?.trim() || "_(no extractable text content)_";
    return [`## ${title}`, ``, `_${page.url}_`, ``, body, ``].join("\n");
  });

  return `${header}\n${sections.join("\n---\n\n")}`.trimEnd() + "\n";
}
