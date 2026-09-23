/**
 * SSRF-safe HTTP(S) fetch. Every server-side fetch of a user-supplied URL in
 * this app MUST go through `safeFetch`. It:
 *
 *  - Rejects non-http(s) schemes.
 *  - Resolves DNS itself and rejects private/loopback/link-local/multicast/
 *    reserved/CGNAT ranges, calling out 169.254.169.254 (cloud metadata)
 *    explicitly.
 *  - Pins the actual TCP connection to the exact IP it validated (via a
 *    custom Node `lookup`), so there is no gap between "we checked the IP"
 *    and "we connected to the IP" for a DNS-rebinding attacker to exploit.
 *  - Follows redirects manually (redirect: "manual" equivalent), capped at
 *    `maxRedirects`, re-validating scheme/port/DNS on every hop.
 *  - Enforces a request timeout and a max response size, aborting the
 *    socket if the cap is exceeded mid-stream.
 *  - Rejects ports outside {80, 443} unless the *original* user-supplied
 *    URL explicitly named that port.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import {
  DEFAULT_ALLOWED_PORTS,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "./constants";

export type SsrfErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "unsupported_port"
  | "dns_resolution_failed"
  | "blocked_ip"
  | "too_many_redirects"
  | "timeout"
  | "network_error";

export class SsrfError extends Error {
  readonly code: SsrfErrorCode;
  constructor(code: SsrfErrorCode, message: string) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  body: Buffer;
  /** True if the response was cut off because it exceeded maxResponseBytes. */
  truncated: boolean;
  /** Every URL hopped through via redirects, in order (excludes the original). */
  redirectChain: string[];
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  userAgent: string;
  accept?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

/** The specific metadata endpoint present on AWS/GCP/Azure/DigitalOcean etc. */
export const CLOUD_METADATA_IP = "169.254.169.254";

// ---------------------------------------------------------------------------
// URL / scheme / port validation
// ---------------------------------------------------------------------------

export function parseUrlStrict(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("invalid_url", `"${raw}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(
      "unsupported_scheme",
      `Scheme "${url.protocol}" is not allowed — only http/https`
    );
  }
  if (!url.hostname) {
    throw new SsrfError("invalid_url", `URL "${raw}" is missing a hostname`);
  }
  return url;
}

/**
 * The set of ports allowed for this crawl target: always 80/443, plus the
 * exact port the *user* originally typed (if any), so a redirect can never
 * introduce a new non-standard port that the user never asked for.
 */
export function allowedPortsForUrl(originalUrl: URL): Set<number> {
  const ports = new Set<number>(DEFAULT_ALLOWED_PORTS);
  if (originalUrl.port) {
    ports.add(Number(originalUrl.port));
  }
  return ports;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export function assertPortAllowed(url: URL, allowedPorts: Set<number>): void {
  const port = effectivePort(url);
  if (!allowedPorts.has(port)) {
    throw new SsrfError("unsupported_port", `Port ${port} is not allowed for ${url.href}`);
  }
}

// ---------------------------------------------------------------------------
// IP validation
// ---------------------------------------------------------------------------

/**
 * True if `ip` must NOT be crawled: anything that isn't plain public unicast
 * (loopback, private/RFC1918, link-local incl. 169.254.169.254, CGNAT,
 * multicast, reserved/"unspecified", benchmarking, documentation ranges,
 * IPv6 unique-local/link-local/multicast, etc).
 */
export function isBlockedIp(ip: string): boolean {
  let addr: ReturnType<typeof ipaddr.process>;
  try {
    addr = ipaddr.process(ip); // unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4
  } catch {
    return true;
  }

  if (addr.kind() === "ipv4") {
    if (addr.toString() === CLOUD_METADATA_IP) return true;
    return addr.range() !== "unicast";
  }

  // ipv6
  return addr.range() !== "unicast";
}

interface ResolvedHost {
  ip: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` (or validates it directly if it's already an IP
 * literal) and rejects the whole hostname if any resolved address is
 * private/reserved — a mix of public + private answers is itself a classic
 * DNS-rebinding smell, not just a curiosity.
 */
export async function resolveAndValidateHost(hostname: string): Promise<ResolvedHost> {
  if (ipaddr.isValid(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfError(
        "blocked_ip",
        `${hostname} is a private/loopback/reserved address, not a public target`
      );
    }
    return { ip: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError("dns_resolution_failed", `DNS lookup failed for "${hostname}"`);
  }

  if (records.length === 0) {
    throw new SsrfError("dns_resolution_failed", `No DNS records for "${hostname}"`);
  }

  if (records.some((r) => isBlockedIp(r.address))) {
    throw new SsrfError(
      "blocked_ip",
      `"${hostname}" resolves to a private/reserved address; refusing to fetch`
    );
  }

  const first = records[0];
  if (!first) {
    throw new SsrfError("dns_resolution_failed", `No DNS records for "${hostname}"`);
  }
  return { ip: first.address, family: first.family === 6 ? 6 : 4 };
}

// ---------------------------------------------------------------------------
// Low-level single request, pinned to a pre-validated IP
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

/**
 * Exported for tests: performs one raw HTTP(S) request pinned to a
 * pre-validated IP, with timeout + max-size enforcement, but no redirect
 * handling (that's `safeFetch`'s job).
 */
export function performPinnedRequest(
  url: URL,
  resolved: ResolvedHost,
  opts: {
    method: string;
    userAgent: string;
    accept?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    // Pin the socket to the IP we already validated — no second DNS lookup
    // happens at connect time, closing the DNS-rebinding TOCTOU window.
    // Node's http/https agents call this with `{ all: true }`, expecting
    // `callback(err, addresses[])`, not the single-address 2-arg form.
    const lookup = ((_hostname: string, opts: unknown, callback: (...args: unknown[]) => void) => {
      const wantsAll =
        typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
      if (wantsAll) {
        callback(null, [{ address: resolved.ip, family: resolved.family }]);
      } else {
        callback(null, resolved.ip, resolved.family);
      }
    }) as unknown as net.LookupFunction;

    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: effectivePort(url),
      path: `${url.pathname}${url.search}`,
      method: opts.method,
      headers: {
        "User-Agent": opts.userAgent,
        Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Connection: "close",
      },
      lookup,
      servername: isHttps ? url.hostname : undefined,
      rejectUnauthorized: true,
    };

    const req = mod.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > opts.maxResponseBytes) {
          settled = true;
          const body = Buffer.concat(chunks);
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, truncated: true });
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated: false,
        });
      });

      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new SsrfError("network_error", err.message));
      });
    });

    req.on("error", (err) => {
      reject(new SsrfError("network_error", err.message));
    });

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy();
      reject(new SsrfError("timeout", `Request to ${url.href} timed out after ${opts.timeoutMs}ms`));
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public entry point: SSRF-safe fetch with manual, re-validated redirects
// ---------------------------------------------------------------------------

export type HostResolver = (hostname: string) => Promise<ResolvedHost>;

/**
 * Same as `safeFetch`, but lets callers inject the hostname→IP resolver.
 * Production code should always use the default (`resolveAndValidateHost`);
 * this seam exists purely so tests can point a fake hostname at a real
 * local test server without weakening the production SSRF blocklist.
 */
export async function safeFetchWithResolver(
  rawUrl: string,
  options: SafeFetchOptions,
  resolveHost: HostResolver = resolveAndValidateHost
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const method = options.method ?? "GET";

  const originalUrl = parseUrlStrict(rawUrl);
  const allowedPorts = allowedPortsForUrl(originalUrl);

  let currentUrl = originalUrl;
  const redirectChain: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertPortAllowed(currentUrl, allowedPorts);
    const resolved = await resolveHost(currentUrl.hostname);

    const res = await performPinnedRequest(currentUrl, resolved, {
      method,
      userAgent: options.userAgent,
      accept: options.accept,
      timeoutMs,
      maxResponseBytes,
    });

    const isRedirect = res.status >= 300 && res.status < 400;
    const rawLocation = res.headers.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;

    if (isRedirect && location) {
      if (hop === maxRedirects) {
        throw new SsrfError(
          "too_many_redirects",
          `Exceeded ${maxRedirects} redirects starting from ${rawUrl}`
        );
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new SsrfError("invalid_url", `Redirect Location header "${location}" is invalid`);
      }
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        throw new SsrfError(
          "unsupported_scheme",
          `Redirect to unsupported scheme "${nextUrl.protocol}"`
        );
      }
      redirectChain.push(nextUrl.href);
      currentUrl = nextUrl;
      continue;
    }

    return {
      status: res.status,
      headers: res.headers,
      finalUrl: currentUrl.href,
      body: res.body,
      truncated: res.truncated,
      redirectChain,
    };
  }

  throw new SsrfError("too_many_redirects", `Exceeded ${maxRedirects} redirects starting from ${rawUrl}`);
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  return safeFetchWithResolver(rawUrl, options, resolveAndValidateHost);
}
