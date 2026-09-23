import { describe, expect, it } from "vitest";
import { checkAndIncrementJobCreationLimit, clampRateLimitRps, tokensAvailable } from "./rateLimiter";
import { HARD_MAX_RATE_LIMIT_RPS, JOB_CREATE_LIMIT_PER_WINDOW, JOB_CREATE_WINDOW_MS } from "./constants";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

describe("clampRateLimitRps", () => {
  it("defaults when unset", () => {
    expect(clampRateLimitRps(undefined)).toBe(3);
    expect(clampRateLimitRps(null)).toBe(3);
    expect(clampRateLimitRps(0)).toBe(3);
    expect(clampRateLimitRps(-5)).toBe(3);
  });

  it("hard-caps above the server maximum regardless of client input", () => {
    expect(clampRateLimitRps(999)).toBe(HARD_MAX_RATE_LIMIT_RPS);
  });

  it("passes through a valid value under the cap", () => {
    expect(clampRateLimitRps(2)).toBe(2);
  });
});

describe("tokensAvailable", () => {
  it("allows full rps when there is no recent traffic", () => {
    expect(tokensAvailable([], 3, 1_000_000)).toBe(3);
  });

  it("reduces availability by requests within the trailing 1s window", () => {
    const now = 1_000_000;
    const recent = [now - 900, now - 500, now - 100];
    expect(tokensAvailable(recent, 3, now)).toBe(0);
  });

  it("ignores requests older than the trailing window", () => {
    const now = 1_000_000;
    const recent = [now - 5000, now - 4000];
    expect(tokensAvailable(recent, 3, now)).toBe(3);
  });

  it("never returns negative tokens", () => {
    const now = 1_000_000;
    const recent = [now, now, now, now, now];
    expect(tokensAvailable(recent, 2, now)).toBe(0);
  });
});

function makeFakeSupabase(initialRow: { owner: string; window_start: string; job_count: number } | null) {
  let row = initialRow;
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        insert(values: { owner: string; window_start: string; job_count: number }) {
          row = { ...values };
          return Promise.resolve({ data: null, error: null });
        },
        update(values: Partial<{ window_start: string; job_count: number }>) {
          return {
            eq() {
              if (row) row = { ...row, ...values };
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as AnySupabase, getRow: () => row };
}

describe("checkAndIncrementJobCreationLimit", () => {
  it("allows the first job and creates a fresh window", async () => {
    const { client, getRow } = makeFakeSupabase(null);
    const result = await checkAndIncrementJobCreationLimit(client, "owner-1");
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(getRow()?.job_count).toBe(1);
  });

  it("increments within the window and blocks once the limit is hit", async () => {
    const { client } = makeFakeSupabase({
      owner: "owner-1",
      window_start: new Date().toISOString(),
      job_count: JOB_CREATE_LIMIT_PER_WINDOW,
    });
    const result = await checkAndIncrementJobCreationLimit(client, "owner-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets the window once it has fully elapsed", async () => {
    const staleStart = new Date(Date.now() - JOB_CREATE_WINDOW_MS - 1000).toISOString();
    const { client, getRow } = makeFakeSupabase({
      owner: "owner-1",
      window_start: staleStart,
      job_count: JOB_CREATE_LIMIT_PER_WINDOW,
    });
    const result = await checkAndIncrementJobCreationLimit(client, "owner-1");
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(getRow()?.job_count).toBe(1);
  });
});
