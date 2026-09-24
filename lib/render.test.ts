import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/ssrf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ssrf")>("@/lib/ssrf");
  return { ...actual, assertUrlIsSafeToFetch: vi.fn() };
});

import { assertUrlIsSafeToFetch, SsrfError } from "@/lib/ssrf";
import { isRequestAllowed } from "@/lib/render";

const ports = new Set([80, 443]);

describe("isRequestAllowed", () => {
  beforeEach(() => {
    vi.mocked(assertUrlIsSafeToFetch).mockReset();
  });

  it("allows data: URLs without touching the SSRF check (inline images etc.)", async () => {
    await expect(isRequestAllowed("data:image/png;base64,AAAA", ports)).resolves.toBe(true);
    expect(assertUrlIsSafeToFetch).not.toHaveBeenCalled();
  });

  it("allows blob: URLs without touching the SSRF check", async () => {
    await expect(isRequestAllowed("blob:https://example.com/uuid", ports)).resolves.toBe(true);
    expect(assertUrlIsSafeToFetch).not.toHaveBeenCalled();
  });

  it("allows about: URLs (e.g. about:blank) without touching the SSRF check", async () => {
    await expect(isRequestAllowed("about:blank", ports)).resolves.toBe(true);
    expect(assertUrlIsSafeToFetch).not.toHaveBeenCalled();
  });

  it("rejects a completely malformed URL", async () => {
    await expect(isRequestAllowed("not a url at all", ports)).resolves.toBe(false);
    expect(assertUrlIsSafeToFetch).not.toHaveBeenCalled();
  });

  it("delegates http(s) URLs to assertUrlIsSafeToFetch and allows when it resolves", async () => {
    vi.mocked(assertUrlIsSafeToFetch).mockResolvedValue(undefined);
    await expect(isRequestAllowed("https://example.com/script.js", ports)).resolves.toBe(true);
    expect(assertUrlIsSafeToFetch).toHaveBeenCalledWith("https://example.com/script.js", ports);
  });

  it("rejects http(s) URLs that assertUrlIsSafeToFetch flags as unsafe (e.g. a page's JS trying to reach a metadata IP)", async () => {
    vi.mocked(assertUrlIsSafeToFetch).mockRejectedValue(new SsrfError("blocked_ip", "blocked"));
    await expect(isRequestAllowed("http://169.254.169.254/latest/meta-data", ports)).resolves.toBe(false);
  });

  it("rejects http(s) URLs on a non-allowed port", async () => {
    vi.mocked(assertUrlIsSafeToFetch).mockRejectedValue(new SsrfError("unsupported_port", "blocked"));
    await expect(isRequestAllowed("https://example.com:8443/x", ports)).resolves.toBe(false);
  });
});
