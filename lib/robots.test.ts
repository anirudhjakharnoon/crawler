import { describe, expect, it } from "vitest";
import { isAllowedPath, parseRobotsTxt } from "./robots";

const FIXTURE_BASIC = `
User-agent: *
Disallow: /private/
Allow: /private/public-page.html
Disallow: /search
Sitemap: https://example.com/sitemap.xml
`;

const FIXTURE_SPECIFIC_BOT = `
User-agent: crawlrbot
Disallow: /no-bots-here/

User-agent: *
Disallow: /
`;

const FIXTURE_ALLOW_ALL_EMPTY_DISALLOW = `
User-agent: *
Disallow:
`;

const FIXTURE_END_ANCHOR = `
User-agent: *
Disallow: /*.pdf$
`;

const FIXTURE_MULTI_UA_GROUP = `
User-agent: googlebot
User-agent: bingbot
Disallow: /shared-block/

User-agent: *
Allow: /
`;

describe("parseRobotsTxt", () => {
  it("extracts sitemap directives", () => {
    const parsed = parseRobotsTxt(FIXTURE_BASIC);
    expect(parsed.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("groups consecutive user-agent lines into one group", () => {
    const parsed = parseRobotsTxt(FIXTURE_MULTI_UA_GROUP);
    const sharedGroup = parsed.groups.find((g) => g.userAgents.includes("googlebot"));
    expect(sharedGroup?.userAgents).toEqual(["googlebot", "bingbot"]);
    expect(sharedGroup?.rules).toEqual([{ type: "disallow", pattern: "/shared-block/" }]);
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseRobotsTxt("# a comment\n\nUser-agent: *\nDisallow: /x # trailing comment\n");
    const group = parsed.groups[0];
    expect(group?.rules).toEqual([{ type: "disallow", pattern: "/x" }]);
  });
});

describe("isAllowedPath", () => {
  it("disallows a blocked prefix", () => {
    const parsed = parseRobotsTxt(FIXTURE_BASIC);
    expect(isAllowedPath(parsed, "CrawlrBot", "/private/secret.html")).toBe(false);
  });

  it("a more specific Allow overrides a shorter Disallow", () => {
    const parsed = parseRobotsTxt(FIXTURE_BASIC);
    expect(isAllowedPath(parsed, "CrawlrBot", "/private/public-page.html")).toBe(true);
  });

  it("allows paths with no matching rule", () => {
    const parsed = parseRobotsTxt(FIXTURE_BASIC);
    expect(isAllowedPath(parsed, "CrawlrBot", "/about")).toBe(true);
  });

  it("disallows an exact-match path", () => {
    const parsed = parseRobotsTxt(FIXTURE_BASIC);
    expect(isAllowedPath(parsed, "CrawlrBot", "/search")).toBe(false);
  });

  it("prefers the bot's specific group over the wildcard group", () => {
    const parsed = parseRobotsTxt(FIXTURE_SPECIFIC_BOT);
    expect(isAllowedPath(parsed, "CrawlrBot", "/no-bots-here/page")).toBe(false);
    // The wildcard group blocks everything, but CrawlrBot's own group takes
    // precedence entirely and only disallows /no-bots-here/.
    expect(isAllowedPath(parsed, "CrawlrBot", "/anything-else")).toBe(true);
  });

  it("falls back to the wildcard group for an unlisted bot", () => {
    const parsed = parseRobotsTxt(FIXTURE_SPECIFIC_BOT);
    expect(isAllowedPath(parsed, "SomeOtherBot", "/anything-else")).toBe(false);
  });

  it("treats an empty Disallow value as allow-all", () => {
    const parsed = parseRobotsTxt(FIXTURE_ALLOW_ALL_EMPTY_DISALLOW);
    expect(isAllowedPath(parsed, "CrawlrBot", "/anything")).toBe(true);
  });

  it("supports the $ end-of-string anchor", () => {
    const parsed = parseRobotsTxt(FIXTURE_END_ANCHOR);
    expect(isAllowedPath(parsed, "CrawlrBot", "/files/report.pdf")).toBe(false);
    expect(isAllowedPath(parsed, "CrawlrBot", "/files/report.pdf.html")).toBe(true);
  });

  it("allows everything when robots.txt is empty (no robots.txt found)", () => {
    const parsed = parseRobotsTxt("");
    expect(isAllowedPath(parsed, "CrawlrBot", "/anything")).toBe(true);
  });
});
