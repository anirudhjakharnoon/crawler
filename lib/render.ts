/**
 * SSRF-safe headless-browser rendering — a fallback used by `lib/crawl/
 * tick.ts` when a fetched page's static HTML looks like an empty
 * client-side-rendered shell (see MIN_WORDS_BEFORE_RENDER_FALLBACK).
 *
 * This is a deliberate, explicit deviation from the original "no headless
 * browser" spec constraint. It's off by default (ENABLE_JS_RENDERING must
 * be set to "true") and only ever engages per-page, after the fast static
 * fetch already ran and looked empty — the overwhelming majority of pages
 * on ordinary server-rendered sites never touch this code path at all.
 *
 * SECURITY: a full browser executes arbitrary page JavaScript, which can
 * issue its own fetch/XHR/image/script/etc. requests to anywhere the page
 * chooses — not just the URL we navigated to. Without validating every
 * single one of those, headless rendering would quietly reopen the exact
 * SSRF hole the rest of this app works hard to close. Every request the
 * page tries to make is validated through the same scheme/port/DNS+IP
 * checks as `lib/ssrf.ts`'s `safeFetch` (via `assertUrlIsSafeToFetch`)
 * before being allowed through; anything that fails is aborted.
 */
import type { Browser, HTTPRequest } from "puppeteer-core";
import { RENDER_TIMEOUT_MS } from "./constants";
import { allowedPortsForUrl, assertUrlIsSafeToFetch, parseUrlStrict, SsrfError } from "./ssrf";

export interface RenderResult {
  html: string;
  finalUrl: string;
}

// Schemes a page can reference without ever causing a real network fetch —
// safe to always allow through the request interceptor untouched.
const HARMLESS_SCHEMES = new Set(["data:", "blob:", "about:", "chrome-extension:"]);

let browserPromise: Promise<Browser> | null = null;

/**
 * @sparticuz/chromium decides, once, at the moment it's first imported,
 * whether it's running on an AL2023-compatible container and needs to
 * extract+link its bundled shared libraries (libnss3.so etc.) accordingly.
 * As of chromium >=137 it does this correctly on Vercel automatically via
 * Vercel's own `VERCEL` env var (always set on deployments) — see
 * https://github.com/Sparticuz/chromium — which is the real fix for the
 * "error while loading shared libraries: libnss3.so: ..." crash this app
 * hit on an older pinned version that predated that detection. This
 * function is a defensive fallback for non-Vercel Lambda-like platforms
 * that don't set `VERCEL` (e.g. Netlify) and is a no-op on Vercel itself;
 * `??=` lets an operator's own env var win if one is already set.
 */
function ensureChromiumRuntimeDetected(): void {
  process.env.AWS_LAMBDA_JS_RUNTIME ??= "nodejs22.x";
}

async function launchBrowser(): Promise<Browser> {
  ensureChromiumRuntimeDetected();
  const [{ default: chromium }, puppeteer] = await Promise.all([
    import("@sparticuz/chromium"),
    import("puppeteer-core"),
  ]);
  const executablePath = await chromium.executablePath();
  // puppeteer-core defaults to headless mode already (no `headless` flag
  // needed) — newer @sparticuz/chromium versions dropped the static
  // `.headless` property that older guides pass here.
  return puppeteer.launch({
    args: chromium.args,
    executablePath,
  });
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser();
  }
  try {
    const browser = await browserPromise;
    if (!browser.connected) {
      browserPromise = launchBrowser();
    }
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

/** Exported for tests: the per-request decision the interceptor makes. */
export async function isRequestAllowed(rawUrl: string, allowedPorts: Set<number>): Promise<boolean> {
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol;
  } catch {
    return false;
  }
  if (HARMLESS_SCHEMES.has(scheme)) return true;
  try {
    await assertUrlIsSafeToFetch(rawUrl, allowedPorts);
    return true;
  } catch (err) {
    if (err instanceof SsrfError) return false;
    return false;
  }
}

export async function renderPage(rawUrl: string, userAgent: string): Promise<RenderResult> {
  const originalUrl = parseUrlStrict(rawUrl);
  const allowedPorts = allowedPortsForUrl(originalUrl);

  // Validate the top-level navigation target up front, same as safeFetch,
  // before spending the cost of launching/using a browser against it.
  await assertUrlIsSafeToFetch(rawUrl, allowedPorts);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(userAgent);
    await page.setRequestInterception(true);

    page.on("request", (request: HTTPRequest) => {
      void isRequestAllowed(request.url(), allowedPorts).then((allowed) => {
        if (allowed) {
          request.continue().catch(() => {});
        } else {
          request.abort("blockedbyclient").catch(() => {});
        }
      });
    });

    const response = await page.goto(rawUrl, {
      waitUntil: "networkidle2",
      timeout: RENDER_TIMEOUT_MS,
    });

    if (!response) {
      throw new SsrfError("network_error", `Headless render produced no response for ${rawUrl}`);
    }

    const html = await page.content();
    return { html, finalUrl: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Exposed for graceful shutdown / tests — normal request handling never needs this. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const promise = browserPromise;
  browserPromise = null;
  const browser = await promise.catch(() => null);
  if (browser) await browser.close().catch(() => {});
}
