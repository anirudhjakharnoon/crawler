import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  allowedPortsForUrl,
  assertPortAllowed,
  isBlockedIp,
  parseUrlStrict,
  performPinnedRequest,
  resolveAndValidateHost,
  safeFetch,
  safeFetchWithResolver,
  SsrfError,
  CLOUD_METADATA_IP,
} from "./ssrf";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup as mockedDnsLookup } from "node:dns/promises";

describe("parseUrlStrict", () => {
  it("accepts http and https", () => {
    expect(parseUrlStrict("http://example.com").protocol).toBe("http:");
    expect(parseUrlStrict("https://example.com").protocol).toBe("https:");
  });

  it("rejects garbage", () => {
    expect(() => parseUrlStrict("not a url")).toThrow(SsrfError);
  });

  it.each(["ftp://example.com", "file:///etc/passwd", "gopher://example.com", "javascript:alert(1)"])(
    "rejects scheme %s",
    (raw) => {
      try {
        parseUrlStrict(raw);
        expect.fail("expected SsrfError");
      } catch (err) {
        expect(err).toBeInstanceOf(SsrfError);
        expect((err as SsrfError).code).toBe("unsupported_scheme");
      }
    }
  );
});

describe("port allowance", () => {
  it("defaults to 80/443 only", () => {
    const ports = allowedPortsForUrl(new URL("https://example.com"));
    expect(ports.has(443)).toBe(true);
    expect(ports.has(80)).toBe(true);
    expect(ports.has(8443)).toBe(false);
  });

  it("allows an explicit original port", () => {
    const ports = allowedPortsForUrl(new URL("https://example.com:8443"));
    expect(ports.has(8443)).toBe(true);
  });

  it("assertPortAllowed throws for a disallowed port", () => {
    const allowed = allowedPortsForUrl(new URL("https://example.com"));
    expect(() => assertPortAllowed(new URL("https://example.com:8443"), allowed)).toThrow(SsrfError);
  });

  it("assertPortAllowed passes for default https port", () => {
    const allowed = allowedPortsForUrl(new URL("https://example.com"));
    expect(() => assertPortAllowed(new URL("https://example.com"), allowed)).not.toThrow();
  });
});

describe("isBlockedIp", () => {
  const blocked = [
    "127.0.0.1", // loopback
    "127.0.0.53",
    "10.0.0.1", // RFC1918
    "172.16.5.4",
    "192.168.1.1",
    "169.254.1.1", // link-local
    CLOUD_METADATA_IP, // cloud metadata, explicitly
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255", // broadcast
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "192.0.2.1", // TEST-NET-1
    "::1", // ipv6 loopback
    "fe80::1", // ipv6 link-local
    "fc00::1", // ipv6 unique-local
    "ff02::1", // ipv6 multicast
    "::ffff:169.254.169.254", // IPv4-mapped IPv6 metadata address
    "not-an-ip",
  ];

  it.each(blocked)("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];

  it.each(allowed)("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("resolveAndValidateHost", () => {
  beforeEach(() => {
    vi.mocked(mockedDnsLookup).mockReset();
  });

  it("validates an IP literal directly without calling DNS", async () => {
    const resolved = await resolveAndValidateHost("8.8.8.8");
    expect(resolved).toEqual({ ip: "8.8.8.8", family: 4 });
    expect(mockedDnsLookup).not.toHaveBeenCalled();
  });

  it("rejects an IP literal that is private", async () => {
    await expect(resolveAndValidateHost("127.0.0.1")).rejects.toMatchObject({ code: "blocked_ip" });
  });

  it("resolves a hostname via DNS and accepts a fully public answer set", async () => {
    vi.mocked(mockedDnsLookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const resolved = await resolveAndValidateHost("public.example.test");
    expect(resolved).toEqual({ ip: "8.8.8.8", family: 4 });
  });

  it("rejects when any resolved answer is private (rebinding smell)", async () => {
    vi.mocked(mockedDnsLookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(resolveAndValidateHost("sneaky.example.test")).rejects.toMatchObject({
      code: "blocked_ip",
    });
  });

  it("surfaces DNS failures as dns_resolution_failed", async () => {
    vi.mocked(mockedDnsLookup).mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveAndValidateHost("nowhere.example.test")).rejects.toMatchObject({
      code: "dns_resolution_failed",
    });
  });
});

describe("safeFetch (scheme/port/DNS rejection paths, no network needed)", () => {
  beforeEach(() => {
    vi.mocked(mockedDnsLookup).mockReset();
  });

  it("rejects non-http(s) schemes before doing anything else", async () => {
    await expect(safeFetch("ftp://example.com", { userAgent: "test" })).rejects.toMatchObject({
      code: "unsupported_scheme",
    });
    expect(mockedDnsLookup).not.toHaveBeenCalled();
  });

  it("rejects when the hostname resolves to a private IP (e.g. SSRF to internal service)", async () => {
    vi.mocked(mockedDnsLookup).mockResolvedValue([{ address: "10.1.2.3", family: 4 }] as never);
    await expect(safeFetch("http://internal.example.test/", { userAgent: "test" })).rejects.toMatchObject({
      code: "blocked_ip",
    });
  });

  it("rejects when the hostname resolves to the cloud metadata address", async () => {
    vi.mocked(mockedDnsLookup).mockResolvedValue([{ address: CLOUD_METADATA_IP, family: 4 }] as never);
    await expect(safeFetch("http://metadata.example.test/", { userAgent: "test" })).rejects.toMatchObject({
      code: "blocked_ip",
    });
  });
});

// ---------------------------------------------------------------------------
// Real-socket tests against a local HTTP server. These exercise the actual
// transport (IP pinning, timeout, max-size truncation, manual redirects) —
// the hostname resolution/blocklist step is stubbed via `safeFetchWithResolver`
// so a real local server can stand in for "the public internet" without
// weakening the production SSRF check (which always blocks loopback).
// ---------------------------------------------------------------------------

describe("performPinnedRequest against a real local server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(1024));
        return;
      }
      if (req.url === "/slow") {
        // never respond — used for timeout test
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches successfully when pinned to the validated IP", async () => {
    const res = await performPinnedRequest(new URL(`http://localhost:${port}/`), { ip: "127.0.0.1", family: 4 }, {
      method: "GET",
      userAgent: "test",
      timeoutMs: 2000,
      maxResponseBytes: 1_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello world");
    expect(res.truncated).toBe(false);
  });

  it("truncates and flags responses over the byte cap", async () => {
    const res = await performPinnedRequest(new URL(`http://localhost:${port}/big`), { ip: "127.0.0.1", family: 4 }, {
      method: "GET",
      userAgent: "test",
      timeoutMs: 2000,
      maxResponseBytes: 100,
    });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(200); // some slack for chunk boundary
  });

  it("rejects with a timeout error if the server never responds", async () => {
    await expect(
      performPinnedRequest(new URL(`http://localhost:${port}/slow`), { ip: "127.0.0.1", family: 4 }, {
        method: "GET",
        userAgent: "test",
        timeoutMs: 150,
        maxResponseBytes: 1_000_000,
      })
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("safeFetchWithResolver redirect handling against a real local server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: `http://redirect-target.test:${port}/next` });
        res.end();
        return;
      }
      if (req.url === "/next") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("final destination");
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { Location: `http://redirect-target.test:${port}/loop` });
        res.end();
        return;
      }
      if (req.url === "/to-weird-port") {
        res.writeHead(302, { Location: `http://redirect-target.test:9999/whatever` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const fakeResolver = async (_hostname: string) => ({ ip: "127.0.0.1" as const, family: 4 as const });

  it("follows a redirect to completion, re-resolving each hop", async () => {
    const res = await safeFetchWithResolver(
      `http://redirect-target.test:${port}/start`,
      { userAgent: "test" },
      fakeResolver
    );
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("final destination");
    expect(res.redirectChain).toHaveLength(1);
  });

  it("gives up after maxRedirects on a redirect loop", async () => {
    await expect(
      safeFetchWithResolver(
        `http://redirect-target.test:${port}/loop`,
        { userAgent: "test", maxRedirects: 3 },
        fakeResolver
      )
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("re-validates the port on every hop and rejects a redirect to a disallowed port", async () => {
    await expect(
      safeFetchWithResolver(
        `http://redirect-target.test:${port}/to-weird-port`,
        { userAgent: "test" },
        fakeResolver
      )
    ).rejects.toMatchObject({ code: "unsupported_port" });
  });
});
