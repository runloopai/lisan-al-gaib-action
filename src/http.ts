/** Shared HTTP fetch helpers with a discriminated result type. */

/** Per-attempt request timeout in milliseconds. */
export const FETCH_TIMEOUT_MS = 5000;

export type FetchResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "error"; status?: number; message: string };

/** Maximum Retry-After delay accepted, in milliseconds. Both delta-seconds and HTTP-date forms are clamped to this cap — a server requesting a longer wait is treated like any other rate-limit and retried with the caller's own backoff. */
const MAX_RETRY_AFTER_MS = 4000;

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds ("120") and HTTP-date forms.
 * Returns undefined when the header is absent or unparseable.
 * The returned value is clamped to MAX_RETRY_AFTER_MS.
 *
 * Exported for testability (gap #3).
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Delta-seconds form: must be a positive decimal integer.
  // Return undefined for 0 — "retry immediately" is indistinguishable from a
  // spec-compliant `Retry-After: 0` that would drive zero-delay back-to-back
  // requests and defeat the backoff+jitter policy. Let the caller use its own
  // exponential backoff instead.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // /^\d+$/ excludes NaN, but a long enough digit string (>308 digits) still
    // overflows to Infinity — reject explicitly rather than relying on the
    // Math.min clamp below to absorb it silently.
    if (!Number.isFinite(seconds) || !(seconds > 0)) return undefined; // also guards seconds===0
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date form
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const delay = ms - Date.now();
    // If the date is in the past or now, return undefined so the caller uses
    // its own exponential backoff rather than hammering with delay=0.
    return delay > 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : undefined;
  }
  return undefined;
}

/**
 * Shared retry/backoff driver. Calls `singleAttempt` repeatedly until:
 *   - it returns `ok` or `not_found` (both are terminal, never retried), or
 *   - the result is non-retryable (4xx that is not 429, or network exhaustion), or
 *   - `maxRetries` attempts have been consumed.
 *
 * Retry policy:
 *   - 429 rate-limited: retry up to maxRetries; delay honors Retry-After header with
 *     positive-only jitter [1.0, 1.25]× so the server's instruction is never undershot.
 *   - 5xx server errors: retry up to maxRetries with exponential backoff + ±25% jitter.
 *   - Network/timeout errors (no HTTP status): retry at most once (maxNetworkRetries=1)
 *     to recover from transient blips without masking persistent failures.
 *
 * Exported for callers that need the raw response (headers, custom status-code
 * classification) beyond what fetchWithRetry/fetchTextWithRetry/fetchHeadWithRetry expose —
 * e.g. OCI registry manifest/blob fetches, which need both a parsed JSON body and response
 * headers together. Such callers supply their own `singleAttempt` classifier and get the same
 * retry/backoff/jitter policy as the built-in helpers, so that policy cannot drift between them.
 */
export async function retryWithBackoff<T>(
  singleAttempt: () => Promise<FetchResult<T>>,
  opts: { maxRetries?: number; initialDelayMs?: number } = {},
): Promise<FetchResult<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  const initialDelayMs = opts.initialDelayMs ?? 250;
  const maxNetworkRetries = 1;
  // networkAttempts is a loop-lifetime budget, not a per-consecutive-window counter:
  // it tracks all network-error attempts across the entire retry loop regardless of
  // any intervening 5xx retries. The "at most one network retry" guarantee holds for
  // mixed sequences (e.g. 5xx→network→network or network→5xx→network).
  let networkAttempts = 0;

  let result: FetchResult<T> = { kind: "error", message: "no attempts made" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = await singleAttempt();

    if (result.kind === "ok" || result.kind === "not_found") return result;

    const isNetworkError = result.kind === "error" && result.status === undefined;
    const isRetryable =
      result.kind === "rate_limited" ||
      (result.kind === "error" && result.status !== undefined && result.status >= 500) ||
      (isNetworkError && networkAttempts < maxNetworkRetries);
    if (isNetworkError) networkAttempts++;
    if (!isRetryable || attempt === maxRetries) return result;

    const backoff = Math.min(initialDelayMs * 2 ** attempt, MAX_RETRY_AFTER_MS);
    // Add jitter so fan-out callers to the same host don't retry in lock-step
    // under a registry-wide 429.
    //
    // For rate-limited responses with a Retry-After header, apply POSITIVE-ONLY
    // jitter ([1.0, 1.25]×) — the server's Retry-After is a contract; waiting
    // *less* than the instructed delay risks an immediate re-429. Positive jitter
    // still de-synchronises the herd without ever undershooting the instruction.
    //
    // For exponential backoff (5xx / network error), symmetric ±25% jitter is fine
    // since no server instruction exists.
    const delay =
      result.kind === "rate_limited" && result.retryAfterMs !== undefined
        // Positive-only jitter [1.0, 1.25]× so the delay never undershoots Retry-After.
        ? Math.min(Math.max(0, Math.round(result.retryAfterMs * (1 + 0.25 * Math.random()))), MAX_RETRY_AFTER_MS)
        // Symmetric ±25% jitter for 5xx/network backoff (no server instruction to honour).
        : Math.min(Math.max(0, Math.round(backoff * (1 + 0.25 * (Math.random() * 2 - 1)))), MAX_RETRY_AFTER_MS);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return result;
}

/**
 * Fetch a URL expecting a JSON body, classifying the response so callers can
 * distinguish 404, rate-limiting, and other errors.
 *
 *   200-299 → { kind: "ok", data }
 *   404/410 → { kind: "not_found" }
 *   429     → { kind: "rate_limited", retryAfterMs? }
 *   other   → { kind: "error", status }
 *   network/timeout → { kind: "error", message }
 */
export async function fetchJson<T>(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchResult<T>> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (resp.ok) {
    try {
      return { kind: "ok", data: (await resp.json()) as T };
    } catch (err) {
      return { kind: "error", status: resp.status, message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (resp.status === 404 || resp.status === 410) return { kind: "not_found" };
  if (resp.status === 429) {
    return { kind: "rate_limited", retryAfterMs: parseRetryAfter(resp.headers.get("Retry-After")) };
  }
  return { kind: "error", status: resp.status, message: `HTTP ${resp.status}` };
}

/**
 * Fetch JSON with retry on rate-limiting and 5xx errors, using exponential
 * backoff capped at 4 seconds. Honors a parsed Retry-After header when present.
 */
export async function fetchWithRetry<T>(
  url: string,
  headers?: Record<string, string>,
  opts: { maxRetries?: number; initialDelayMs?: number } = {},
): Promise<FetchResult<T>> {
  return retryWithBackoff(() => fetchJson<T>(url, headers), opts);
}

/**
 * Fetch a URL expecting a plain-text body (e.g. XML), with retry on rate-limiting and
 * 5xx errors using exponential backoff. Returns a discriminated FetchResult<string> so
 * callers can distinguish 404 (not_found) from transient errors without a second probe.
 *
 * Delegates to the same {@link retryWithBackoff} driver as {@link fetchWithRetry} so
 * retry/backoff/jitter policy stays in a single place and cannot drift.
 */
export async function fetchTextWithRetry(
  url: string,
  headers?: Record<string, string>,
  opts: { maxRetries?: number; initialDelayMs?: number } = {},
): Promise<FetchResult<string>> {
  return retryWithBackoff(async (): Promise<FetchResult<string>> => {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (resp.ok) {
        try {
          return { kind: "ok", data: await resp.text() };
        } catch (err) {
          return { kind: "error", status: resp.status, message: err instanceof Error ? err.message : String(err) };
        }
      }
      if (resp.status === 404 || resp.status === 410) return { kind: "not_found" };
      if (resp.status === 429) {
        return { kind: "rate_limited", retryAfterMs: parseRetryAfter(resp.headers.get("Retry-After")) };
      }
      return { kind: "error", status: resp.status, message: `HTTP ${resp.status}` };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }, opts);
}

/**
 * Issue a HEAD request with the same retry/backoff/classification policy as
 * fetchWithRetry/fetchTextWithRetry. Returns a discriminated FetchResult where:
 *   ok        → the response was 2xx; `data.headers` gives access to response headers
 *   not_found → 404 or 410 (no retry)
 *   rate_limited → 429 (retried with Retry-After backoff)
 *   error     → other 4xx, 5xx (retried on 5xx), or network failure
 */
export async function fetchHeadWithRetry(
  url: string,
  headers?: Record<string, string>,
  opts: { maxRetries?: number; initialDelayMs?: number } = {},
): Promise<FetchResult<{ headers: { get(name: string): string | null } }>> {
  return retryWithBackoff(async (): Promise<FetchResult<{ headers: { get(name: string): string | null } }>> => {
    try {
      const resp = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (resp.ok) {
        return { kind: "ok", data: { headers: resp.headers } };
      }
      if (resp.status === 404 || resp.status === 410) return { kind: "not_found" };
      if (resp.status === 429) {
        return { kind: "rate_limited", retryAfterMs: parseRetryAfter(resp.headers.get("Retry-After")) };
      }
      return { kind: "error", status: resp.status, message: `HTTP ${resp.status}` };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }, opts);
}
