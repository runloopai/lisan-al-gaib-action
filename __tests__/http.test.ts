import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, fetchJson, fetchTextWithRetry, fetchHeadWithRetry, parseRetryAfter } from "../src/http.js";

function fakeResponse(opts: {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => opts.body ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

describe("fetchJson", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("classifies 200/404/429/other/network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 200, body: { a: 1 } }));
    expect(await fetchJson("u")).toEqual({ kind: "ok", data: { a: 1 } });

    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 404 }));
    expect(await fetchJson("u")).toEqual({ kind: "not_found" });

    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 429, headers: { "Retry-After": "2" } }),
    );
    expect(await fetchJson("u")).toEqual({ kind: "rate_limited", retryAfterMs: 2000 });

    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 500 }));
    expect(await fetchJson("u")).toMatchObject({ kind: "error", status: 500 });

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await fetchJson("u")).toMatchObject({ kind: "error", message: "ECONNRESET" });

    // Retry-After: 0 must yield retryAfterMs: undefined so the caller falls back
    // to exponential backoff (not an immediate retry that defeats rate-limit protection).
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 429, headers: { "Retry-After": "0" } }),
    );
    expect(await fetchJson("u")).toEqual({ kind: "rate_limited", retryAfterMs: undefined });

    vi.unstubAllGlobals();
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Make backoff instantaneous and capture requested delays.
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does not retry on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r.kind).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a 4xx error (<500)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 429 }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx up to maxRetries then returns the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 2, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("retries a status-less network error once then returns the error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", message: "ECONNRESET" });
    // Only 2 attempts: 1 initial + 1 network retry (maxNetworkRetries=1), then stops
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the network error succeeds on the retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After (capped at 4s) on 429", async () => {
    const delays: number[] = [];
    (global.setTimeout as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      ((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 429, headers: { "Retry-After": "999" } }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 1, initialDelayMs: 0 });
    expect(r.kind).toBe("ok");
    // 999s requested → capped to 4000ms, then positive-only jitter [1.0, 1.25]× applied
    // → [4000, 5000] but re-capped at MAX_RETRY_AFTER_MS=4000 → always exactly 4000.
    // (Positive-only jitter never undershoots the server's Retry-After instruction.)
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(4000);
  });

  it("M2: 5xx symmetric jitter never exceeds MAX_RETRY_AFTER_MS (4000ms) after re-clamp", async () => {
    // With a large initialDelayMs the raw backoff saturates at MAX_RETRY_AFTER_MS (4000ms).
    // Symmetric ±25% jitter could push it to 4000*1.25=5000ms without re-clamping.
    // The fix re-clamps the jittered value — run 20 iterations to verify the cap holds.
    const capturedDelays: number[] = [];
    (global.setTimeout as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      ((fn: () => void, ms?: number) => {
        capturedDelays.push(ms ?? 0);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );

    for (let i = 0; i < 20; i++) {
      capturedDelays.length = 0;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ status: 503 }))
        .mockResolvedValueOnce(fakeResponse({ status: 200, body: {} }));
      vi.stubGlobal("fetch", fetchMock);
      // initialDelayMs=10000 ensures backoff = min(10000*2^0, 4000) = 4000 before jitter.
      await fetchWithRetry("u", undefined, { maxRetries: 1, initialDelayMs: 10000 });
      expect(capturedDelays).toHaveLength(1);
      // Must never exceed 4000ms even with +25% jitter applied.
      expect(capturedDelays[0]).toBeLessThanOrEqual(4000);
    }
  });

  it("M3: network-retry budget holds across mixed sequences (5xx→network→network)", async () => {
    // The "at most one network retry" budget is a loop-lifetime counter, not consecutive.
    // After one 5xx retry and then two network errors, the budget (1) is exhausted on the
    // second network error — the function stops at attempt 3 (0-indexed: 0,1,2).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 503 }))  // attempt 0: 5xx → retry
      .mockRejectedValueOnce(new Error("ECONNRESET"))         // attempt 1: network → budget 1 used
      .mockRejectedValueOnce(new Error("ECONNRESET"));        // attempt 2: network → budget exhausted
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", message: "ECONNRESET" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // stops after 2nd network error, not 4th
  });

  it("M3: network-retry budget holds across mixed sequences (network→5xx→network)", async () => {
    // After one network error (budget 1 used) and a 5xx retry, the second network error
    // finds the budget exhausted and the function stops at attempt 3.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))           // attempt 0: network → budget 1 used
      .mockResolvedValueOnce(fakeResponse({ status: 503 }))   // attempt 1: 5xx → retry (budget unchanged)
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));          // attempt 2: network → budget exhausted
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchWithRetry("u", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", message: "ETIMEDOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rate-limited delay is never less than the Retry-After instruction", async () => {
    // Run 20 iterations with a short Retry-After to verify positive-only jitter never
    // undershoots the server's delay (the key invariant of the [1.0, 1.25]× jitter).
    const retryAfterSec = 1; // 1000ms
    const capturedDelays: number[] = [];
    (global.setTimeout as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      ((fn: () => void, ms?: number) => {
        capturedDelays.push(ms ?? 0);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );

    for (let i = 0; i < 20; i++) {
      capturedDelays.length = 0;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeResponse({ status: 429, headers: { "Retry-After": String(retryAfterSec) } }),
        )
        .mockResolvedValueOnce(fakeResponse({ status: 200, body: {} }));
      vi.stubGlobal("fetch", fetchMock);
      await fetchWithRetry("u", undefined, { maxRetries: 1, initialDelayMs: 0 });
      expect(capturedDelays).toHaveLength(1);
      // Delay must be >= retryAfterMs (1000ms) — positive-only jitter guarantees this.
      expect(capturedDelays[0]).toBeGreaterThanOrEqual(retryAfterSec * 1000);
    }
  });
});

// ─── gap #2: fetchTextWithRetry ─────────────────────────────────────────────

describe("fetchTextWithRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns ok with text body on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ status: 200, text: "<xml/>" })));
    const r = await fetchTextWithRetry("u");
    expect(r).toEqual({ kind: "ok", data: "<xml/>" });
  });

  it("does not retry on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchTextWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r.kind).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies 410 as not_found (gap #3 — applies to text path too)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchTextWithRetry("u");
    expect(r).toEqual({ kind: "not_found" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
  });

  it("retries on 429 then returns ok text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 429 }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchTextWithRetry("u", undefined, { initialDelayMs: 0 });
    expect(r).toEqual({ kind: "ok", data: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx up to maxRetries then returns error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchTextWithRetry("u", undefined, { maxRetries: 2, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("network error retried once then returns error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchTextWithRetry("u", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", message: "ECONNRESET" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── gap #3: parseRetryAfter edge cases ─────────────────────────────────────

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
  });

  it("returns undefined for delta-seconds = 0 (avoid immediate retry)", () => {
    expect(parseRetryAfter("0")).toBeUndefined();
  });

  it("clamps delta-seconds larger than MAX_RETRY_AFTER_MS to 4000", () => {
    expect(parseRetryAfter("999")).toBe(4000);
  });

  it("returns undefined for null header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("returns undefined for unparseable string", () => {
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });

  it("HTTP-date form: past date returns undefined (avoid delay=0 hammering)", () => {
    // A date in the past means delay <= 0 → undefined (fall back to exponential backoff).
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(pastDate)).toBeUndefined();
  });

  it("HTTP-date form: future date within cap returns positive ms", () => {
    // toUTCString() rounds to the nearest second, so use a 3s-in-future date and allow
    // a wide tolerance: the result should be positive and no more than the 4s cap.
    const futureDate = new Date(Date.now() + 3000).toUTCString();
    const result = parseRetryAfter(futureDate);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(4000);
  });

  it("HTTP-date form: future date beyond cap is clamped to 4000", () => {
    const farFuture = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(farFuture)).toBe(4000);
  });
});

// ─── fetchHeadWithRetry ──────────────────────────────────────────────────────

describe("fetchHeadWithRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns ok with accessible headers on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ status: 200, headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/file");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.data.headers.get("last-modified")).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
    }
    // Must have used HEAD method
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/file",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_found on 404 (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/missing");
    expect(r.kind).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_found on 410 (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/gone");
    expect(r.kind).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then returns ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 429 }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, headers: { "X-Custom": "yes" } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/pom", undefined, { initialDelayMs: 0 });
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx up to maxRetries then returns error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/pom", undefined, { maxRetries: 2, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("retries network error once then returns error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/pom", undefined, { maxRetries: 3, initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", message: "ECONNRESET" });
    // Only 2 attempts: 1 initial + 1 network retry (maxNetworkRetries=1)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx (other than 404/410/429)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchHeadWithRetry("https://example.com/pom", undefined, { initialDelayMs: 0 });
    expect(r).toMatchObject({ kind: "error", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400-digit Retry-After integer string: parseRetryAfter rejects the overflowed value explicitly", () => {
    // Number("9".repeat(400)) → Infinity. An explicit Number.isFinite guard rejects
    // this rather than silently relying on the Math.min clamp below to absorb it.
    expect(parseRetryAfter("9".repeat(400))).toBeUndefined();
  });
});
