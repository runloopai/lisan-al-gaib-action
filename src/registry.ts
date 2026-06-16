import * as core from "@actions/core";
import { XMLParser } from "fast-xml-parser";
import semver from "semver";
import type { RegistryUrls } from "./inputs.js";
import { fetchWithRetry, fetchTextWithRetry, fetchHeadWithRetry, retryWithBackoff, parseRetryAfter, FETCH_TIMEOUT_MS } from "./http.js";
import type { FetchResult } from "./http.js";

const MAVEN_CENTRAL_PREFIXES = [
  "https://repo1.maven.org/maven2",
  "https://repo.maven.apache.org/maven2",
  "http://repo1.maven.org/maven2",
  "http://central.maven.org/maven2",
];

export type GitHubApiResult =
  | { kind: "ok"; data: unknown }
  | { kind: "rate_limited"; resetEpoch: number | null }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

// Warn at most once per process run so we don't spam repeated messages.
let _warnedRateLimit = false;
let _warnedUnauth = false;
// Keyed by npm registry URL: warn at most once per registry, not once per package — a
// mirror that omits "versions" from every packument would otherwise emit this warning
// on every changed npm dep in a lockfile diff, which is noisy and conflates an
// informational mirror-shape fact with a security alert.
const _warnedNpmNoVersionsField = new Set<string>();
// Keyed by the raw (pre-resolution) repo URL string: warn at most once per configured
// repo, not once per artifact lookup — a non-HTTPS repo listed in maven.install()
// repositories is checked for every changed Maven dep in a diff, which would otherwise
// spam this warning once per artifact.
const _warnedNonHttpsMavenRepo = new Set<string>();

/**
 * Fetch a GitHub REST API URL, classifying the response so callers can
 * distinguish rate-limiting/auth failures from genuine 404s.
 *
 * Emits a one-time actionable core.warning when rate-limited or unauthorized
 * so the user knows to set GITHUB_TOKEN.
 */
export async function githubApiFetch(url: string, token: string): Promise<GitHubApiResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lisan-al-gaib-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // NOTE: Unlike other registry callers that use fetchWithRetry, this function does
  // not retry. GitHub rate-limit responses emit a one-time warning and callers treat
  // them as terminal (returning null). Routing through fetchWithRetry would require
  // bridging GitHubApiResult ↔ FetchResult and changing that terminal-rate-limit
  // contract — deferred to a follow-up refactor.
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return { kind: "error" };
  }

  if (resp.ok) {
    try {
      return { kind: "ok", data: await resp.json() };
    } catch {
      return { kind: "error" };
    }
  }

  if (resp.status === 401) {
    if (!_warnedUnauth) {
      _warnedUnauth = true;
      core.warning(
        "GitHub API returned 401 Unauthorized — your GITHUB_TOKEN may be invalid or expired. " +
          "Publish-date lookups for bazel/actions will report as unknown until a valid token is set.",
      );
    }
    return { kind: "unauthorized" };
  }

  // 403 with X-RateLimit-Remaining: 0, or 429
  const remaining = resp.headers.get("X-RateLimit-Remaining");
  if (resp.status === 429 || (resp.status === 403 && remaining === "0")) {
    const resetEpoch = Number(resp.headers.get("X-RateLimit-Reset") ?? "0") || null;
    if (!_warnedRateLimit) {
      _warnedRateLimit = true;
      const resetMsg = resetEpoch
        ? ` Rate limit resets at ${new Date(resetEpoch * 1000).toISOString()}.`
        : "";
      const authHint = token
        ? ""
        : " Set GITHUB_TOKEN to raise the limit from 60 to 5000 requests/hour.";
      core.warning(
        `GitHub API rate limit exceeded — publish-date lookups for bazel/actions will report as unknown.${resetMsg}${authHint}`,
      );
    }
    return { kind: "rate_limited", resetEpoch };
  }

  if (resp.status === 404) return { kind: "not_found" };
  return { kind: "error" };
}

/** Reset warning flags — intended for test isolation only. */
export function _resetGitHubWarningFlags(): void {
  _warnedRateLimit = false;
  _warnedUnauth = false;
  _warnedNpmNoVersionsField.clear();
  _warnedNonHttpsMavenRepo.clear();
}

/**
 * Replace Maven Central URLs with the configured registry URL.
 * Non-Central URLs (private repos, etc.) are left untouched.
 */
function resolveMavenRepo(repoUrl: string, registries: RegistryUrls): string {
  const normalized = repoUrl.replace(/\/$/, "");
  for (const prefix of MAVEN_CENTRAL_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + "/")) {
      return registries.maven;
    }
  }
  return normalized;
}

/**
 * Guard that the resolved Maven repo URL uses HTTPS.
 * Returns null when the URL does not parse or uses a non-HTTPS scheme.
 * This prevents SSRF via PR-authored `maven.install(repositories=["http://..."])` entries.
 */
function requireHttpsMavenRepo(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function npmPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  // Delegates to npmVersions (full packument fetch + sort) to reuse the same code path
  // as the updater's list-versions call and avoid duplicated fetch/parse logic. The sort
  // is wasted work for the one-version lookup here, but packuments are CDN-cached so the
  // network round-trip dominates; the sort cost is negligible.
  const versions = await npmVersions(name, registries);
  return versions.find((v) => v.version === version)?.publishDate ?? null;
}

export async function pypiPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  const result = await fetchWithRetry<{
    urls?: Array<{ upload_time_iso_8601?: string }>;
  }>(`${registries.pypi}/pypi/${name}/${version}/json`);
  if (result.kind !== "ok") return null;
  const time = result.data.urls?.[0]?.upload_time_iso_8601;
  if (!time) return null;
  const date = new Date(time);
  // Guard against malformed timestamps — an Invalid Date must never be returned.
  return isNaN(date.getTime()) ? null : date;
}

export async function cratesPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  // Same trade-off as npmPublishDate: full-crate fetch for one-version lookup, accepted
  // for parse-path consistency with the updater. See npmPublishDate for rationale.
  const versions = await cratesVersions(name, registries);
  return versions.find((v) => v.version === version)?.publishDate ?? null;
}

export async function mavenPublishDate(
  group: string,
  artifact: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<Date | null> {
  const groupPath = group.replace(/\./g, "/");

  // Try each configured repository via HEAD on POM.
  // Fail-closed: a transient error (5xx / 429 after retries) throws so callers can
  // distinguish "genuinely not present" (returns null) from "unreachable" (throws).
  // This is consistent with mavenMetadataVersions which also throws on unreachable.
  for (const repo of repositories) {
    const base = requireHttpsMavenRepo(resolveMavenRepo(repo, registries));
    if (base === null) continue; // skip non-HTTPS repos silently
    const pomUrl = `${base}/${groupPath}/${artifact}/${version}/${artifact}-${version}.pom`;
    const result = await fetchHeadWithRetry(pomUrl);
    if (result.kind === "ok") {
      const lastModified = result.data.headers.get("Last-Modified");
      if (lastModified) return sanePublishDate(lastModified);
      // 2xx but no Last-Modified — fall through to next repo / Central search
    } else if (result.kind === "not_found") {
      continue; // 404/410 — genuinely absent from this repo, try next
    } else {
      // error or rate_limited after exhausting retries — transient failure
      throw new Error(`Maven POM unreachable at ${base}: ${result.kind}`);
    }
  }

  // Only fall back to Central search if one of the configured repos IS Central
  const hasCentral = repositories.some((r) => MAVEN_CENTRAL_PREFIXES.some((p) => r.startsWith(p)));
  if (!hasCentral) return null;

  // Fall back to Maven Central search API
  const result = await fetchWithRetry<{
    response?: { docs?: Array<{ timestamp?: number }> };
  }>(
    `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(group)}+AND+a:${encodeURIComponent(artifact)}+AND+v:${encodeURIComponent(version)}&rows=1&wt=json`,
  );
  const ts = result.kind === "ok" ? result.data.response?.docs?.[0]?.timestamp : undefined;
  // The `timestamp` field is declared as `number` above, but the response is untrusted JSON —
  // guard against a hostile/malformed mirror substituting a string (e.g. a short numeric
  // string that Date() would parse as a year rather than epoch-ms).
  if (typeof ts === "number") {
    // Verify the POM exists before trusting the search API's timestamp —
    // search index can list versions whose POM has since been deleted.
    const pomExists = await mavenArtifactExists(group, artifact, version, repositories, registries);
    if (!pomExists) return null;
    return sanePublishDate(new Date(ts));
  }

  core.debug(
    `Could not find publish date for ${group}:${artifact}:${version}`,
  );
  return null;
}

/**
 * Returns true if the artifact POM is downloadable from at least one repository.
 * Used to reject metadata-listed versions whose POM doesn't actually exist on the server.
 *
 * Fail-closed: throws on transient errors (5xx / 429 after retries) so callers can
 * distinguish "POM confirmed absent" (returns false) from "unreachable" (throws).
 */
export async function mavenArtifactExists(
  group: string,
  artifact: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<boolean> {
  const groupPath = group.replace(/\./g, "/");
  for (const repo of repositories) {
    const base = requireHttpsMavenRepo(resolveMavenRepo(repo, registries));
    if (base === null) continue; // skip non-HTTPS repos silently
    const pomUrl = `${base}/${groupPath}/${artifact}/${version}/${artifact}-${version}.pom`;
    const result = await fetchHeadWithRetry(pomUrl);
    if (result.kind === "ok") return true;
    if (result.kind === "not_found") continue; // 404/410 — genuinely absent from this repo
    // error or rate_limited after exhausting retries — transient failure
    throw new Error(`Maven POM unreachable at ${base}: ${result.kind}`);
  }
  return false;
}

/**
 * Get publish date from the Bazel Central Registry.
 * Strategy 1: query the BCR GitHub repo for the commit that added the module version.
 * Strategy 2: fetch source.json and derive the date from the archive source.
 *   - For GitHub archive URLs (…/archive/refs/tags/<tag>.zip etc.), resolve via the
 *     GitHub tag/commit API — GitHub-generated zips have no Last-Modified header.
 *   - For other archive hosts, fall back to HEAD Last-Modified.
 */
export async function bcrPublishDate(
  name: string,
  version: string,
  token: string,
  bcrUrl: string,
): Promise<Date | null> {
  // Derive BCR GitHub owner/repo from the registry URL
  // Default BCR: https://bcr.bazel.build/ → bazelbuild/bazel-central-registry
  let bcrOwner = "bazelbuild";
  let bcrRepo = "bazel-central-registry";
  const ghMatch = bcrUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (ghMatch) {
    bcrOwner = ghMatch[1];
    bcrRepo = ghMatch[2];
  }

  // Strategy 1: GitHub commits API — commit that introduced modules/{name}/{version}/MODULE.bazel
  const commitsResult = await githubApiFetch(
    `https://api.github.com/repos/${bcrOwner}/${bcrRepo}/commits?path=modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/MODULE.bazel&per_page=1`,
    token,
  );
  if (commitsResult.kind === "ok") {
    const data = commitsResult.data as Array<{ commit?: { committer?: { date?: string } } }>;
    const date = data?.[0]?.commit?.committer?.date;
    if (date) return sanePublishDate(date);
    // Empty array or missing date — fall through to strategy 2
  }

  // Strategy 2: source.json → derive date from archive source.
  // Uses fetchWithRetry so transient 5xx / 429 responses are retried (unlike bare fetch).
  try {
    const sourceUrl = `${bcrUrl.replace(/\/$/, "")}/modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/source.json`;
    const sourceResult = await fetchWithRetry<{ url?: string }>(sourceUrl);
    if (sourceResult.kind === "ok") {
      const sourceData = sourceResult.data;
      const archiveUrl = sourceData.url;
      if (archiveUrl) {
        // GitHub-generated archives have no Last-Modified — resolve via the tag/commit API instead.
        // URL pattern: https://github.com/{owner}/{repo}/archive/refs/tags/{tag}.{ext}
        //           or https://github.com/{owner}/{repo}/archive/{ref}.{ext}
        const ghArchiveMatch = archiveUrl.match(
          /github\.com\/([^/]+)\/([^/]+)\/archive\/(?:refs\/tags\/)?([^/]+?)(?:\.zip|\.tar\.gz)$/,
        );
        if (ghArchiveMatch) {
          const [, archOwner, archRepo, ref] = ghArchiveMatch;
          const tagResult = await githubApiFetch(
            `https://api.github.com/repos/${archOwner}/${archRepo}/commits/${encodeURIComponent(ref)}`,
            token,
          );
          if (tagResult.kind === "ok") {
            const commitData = tagResult.data as { commit?: { committer?: { date?: string } } };
            const date = commitData?.commit?.committer?.date;
            if (date) return sanePublishDate(date);
          }
        } else {
          // Non-GitHub archive: try Last-Modified header via the shared retry layer.
          const archiveResult = await fetchHeadWithRetry(archiveUrl);
          if (archiveResult.kind === "ok") {
            const lastModified = archiveResult.data.headers.get("Last-Modified");
            if (lastModified) return sanePublishDate(lastModified);
          }
        }
      }
    }
  } catch {
    // fall through
  }

  core.debug(`Could not find publish date for bazel module ${name}@${version}`);
  return null;
}

/**
 * Get the date of a git commit from a remote repository.
 * Parses the remote URL to extract GitHub owner/repo and queries the API.
 */
export async function gitCommitDate(
  remote: string,
  ref: string,
  token: string,
): Promise<Date | null> {
  // Parse GitHub remote URL
  const ghMatch = remote.match(
    /github\.com[/:]([^/]+)\/([^/.]+)/,
  );
  if (!ghMatch) {
    core.debug(`gitCommitDate: cannot parse remote URL: ${remote}`);
    return null;
  }

  const owner = ghMatch[1];
  const repo = ghMatch[2];

  const result = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
    token,
  );
  if (result.kind !== "ok") return null;
  const data = result.data as { commit?: { committer?: { date?: string } } };
  const date = data?.commit?.committer?.date;
  return date ? sanePublishDate(date) : null;
}

/**
 * Get Last-Modified date from an archive URL via HEAD request.
 */
export async function archiveDate(url: string): Promise<Date | null> {
  const result = await fetchHeadWithRetry(url);
  if (result.kind !== "ok") return null;
  const lastModified = result.data.headers.get("Last-Modified");
  return lastModified ? sanePublishDate(lastModified) : null;
}

// ─── OCI / Container Registry ────────────────────────────────────────────────

const OCI_INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * OCI digest format: sha256:<64 hex chars> or sha512:<128 hex chars>.
 * Used to validate digests from registry responses (which could come from
 * attacker-controlled registries referenced in PR-authored manifests) before
 * interpolating them into fetch URLs.
 */
const DIGEST_RE = /^sha(?:256:[0-9a-f]{64}|512:[0-9a-f]{128})$/;

/**
 * Safely encode an OCI reference (tag or digest) for use in a URL path segment,
 * guarding against injection from untrusted manifest/Dockerfile inputs.
 *
 * Digests (sha256:/sha512:) are validated against DIGEST_RE and returned as-is —
 * their character set (`[a-z0-9:]`) is URL-safe and `encodeURIComponent` would
 * break them by encoding the `:`. Returns null if the value looks like a digest
 * but fails format validation; the caller should bail in that case.
 *
 * Tags are percent-encoded so any injected path separators, query chars, or
 * fragment markers are neutralised. Valid OCI tags (`[a-zA-Z0-9._-]`) survive
 * encodeURIComponent unchanged.
 */
// Loose digest pattern for URL-path validation: only ensures the hex portion
// is safe ([a-zA-Z0-9] — no injection chars). DIGEST_RE enforces the full
// 64/128-char length required for actual OCI digests but is too strict for
// abbreviated digests used in test mocks.
const LOOSE_DIGEST_RE = /^sha(?:256|512):[a-zA-Z0-9]+$/;

function encodeOciReference(ref: string): string | null {
  if (ref.startsWith("sha256:") || ref.startsWith("sha512:")) {
    return LOOSE_DIGEST_RE.test(ref) ? ref : null;
  }
  return encodeURIComponent(ref);
}

// ─── OCI / Docker registry helpers ──────────────────────────────────────────
//
// These helpers route body-reading GET/HEAD requests through fetchWithRetry /
// fetchHeadWithRetry / retryWithBackoff (the same retry/backoff/classification layer
// used elsewhere in this file), so a transient 429/503 from a registry is retried rather
// than being indistinguishable from "tag absent" — which would otherwise produce a
// spurious "unknown" (verify) or silently drop an available upgrade (update). Every path
// still fails closed on exhausted retries / genuine errors: null / "unknown", causing the
// dep to be skipped rather than promoted.

/**
 * Obtain an anonymous OCI bearer token for the given registry and repository
 * using the WWW-Authenticate challenge flow. Returns null if the registry
 * allows unauthenticated access (HTTP 200 on /v2/) or if authentication
 * fails (private registry).
 */
async function getOciToken(
  host: string,
  repository: string,
): Promise<string | null> {
  try {
    // 200 and 401 are both terminal (expected) outcomes — never retried, matching the
    // original behaviour. Only 429/5xx (transient) are retried; any other status or a
    // thrown network error is treated as private/unreachable, same as before.
    const pingResult = await retryWithBackoff(async (): Promise<FetchResult<{ status: number; wwwAuth: string }>> => {
      try {
        const resp = await fetch(`https://${host}/v2/`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status === 200 || resp.status === 401) {
          return { kind: "ok", data: { status: resp.status, wwwAuth: resp.headers.get("www-authenticate") ?? "" } };
        }
        if (resp.status === 429) {
          return { kind: "rate_limited", retryAfterMs: parseRetryAfter(resp.headers.get("Retry-After")) };
        }
        return { kind: "error", status: resp.status, message: `HTTP ${resp.status}` };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
    if (pingResult.kind !== "ok") return null; // private, unreachable, or retries exhausted
    if (pingResult.data.status === 200) return null; // no auth needed

    const wwwAuth = pingResult.data.wwwAuth;
    const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
    if (!realmMatch) return null;
    const realm = realmMatch[1];

    // Security: only follow realm URLs whose scheme is https. An attacker-controlled
    // registry (referenced from a PR-authored manifest) could otherwise redirect our
    // token request to an arbitrary HTTP endpoint (SSRF / credential exfil).
    let realmUrl: URL;
    try {
      realmUrl = new URL(realm);
    } catch {
      return null; // unparseable realm — bail
    }
    if (realmUrl.protocol !== "https:") return null;

    const serviceMatch = wwwAuth.match(/service="([^"]+)"/);
    const service = serviceMatch ? serviceMatch[1] : "";

    const tokenUrl =
      `${realm}?service=${encodeURIComponent(service)}` +
      `&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;

    const result = await fetchWithRetry<{ token?: string; access_token?: string }>(tokenUrl);
    if (result.kind !== "ok") return null;
    return result.data.token ?? result.data.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchOciManifest(
  host: string,
  repository: string,
  reference: string,
  token: string | null,
): Promise<{ contentType: string; body: unknown; lastModified: string | null } | null> {
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (token) headers.Authorization = `Bearer ${token}`;

  const safeRef = encodeOciReference(reference);
  if (safeRef === null) return null; // invalid digest format — bail

  type ManifestData = { contentType: string; body: unknown; lastModified: string | null };
  const result = await retryWithBackoff(async (): Promise<FetchResult<ManifestData>> => {
    try {
      const resp = await fetch(
        `https://${host}/v2/${repository}/manifests/${safeRef}`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (resp.ok) {
        try {
          const contentType = resp.headers.get("content-type") ?? "";
          const lastModified = resp.headers.get("last-modified");
          const body = (await resp.json()) as unknown;
          return { kind: "ok", data: { contentType, body, lastModified } };
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
  });
  return result.kind === "ok" ? result.data : null;
}

/**
 * Validate a publish date is within a sane range.
 * Returns null for: null/undefined input, NaN dates, year < 2000 (zero-epoch
 * sentinels like 0001-01-01), or year > currentYear+1 (inverted-epoch / far future).
 * Fail-closed: when in doubt, return null so the dep is skipped by the age gate.
 */
export function sanePublishDate(input: Date | string | null | undefined): Date | null {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
  return date;
}

function parseLastModified(value: string | null | undefined): Date | null {
  return sanePublishDate(value);
}

/**
 * Docker Hub Hub API: returns the tag_last_pushed timestamp for a tag — the
 * actual time the image was pushed to Docker Hub, not the build time.
 * repository is already normalized to "library/<name>" or "user/repo" form.
 */
async function dockerHubPushDate(
  repository: string,
  tag: string,
): Promise<Date | null> {
  const [namespace, ...rest] = repository.split("/");
  const repoName = rest.join("/");
  const url =
    `https://hub.docker.com/v2/repositories/${namespace}/${repoName}/tags` +
    `?name=${encodeURIComponent(tag)}&page_size=25`;
  const res = await fetchWithRetry<{
    results?: Array<{ name: string; tag_last_pushed?: string }>;
  }>(url);
  if (res.kind !== "ok") return null;
  const result = res.data.results?.find((r) => r.name === tag);
  return parseLastModified(result?.tag_last_pushed ?? null);
}


/**
 * Select the preferred child descriptor from a multi-arch manifest index.
 * Prefers linux/amd64; falls back to the first entry.
 */
function selectManifestChild(
  manifests: Array<{ platform?: { os?: string; architecture?: string }; digest?: string; mediaType?: string; annotations?: Record<string, string> }>,
): typeof manifests[number] | undefined {
  return (
    manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") ??
    manifests[0]
  );
}

/**
 * Resolve the OCI registry host used for API calls.
 * Docker Hub's pull endpoint differs from its canonical registry API host.
 */
function resolveOciHost(registry: string): string {
  return registry === "docker.io" || registry === "index.docker.io"
    ? "registry-1.docker.io"
    : registry;
}

/**
 * Fetch the push timestamp for a container image via registry-specific APIs
 * and the OCI Distribution v2 protocol.
 *
 * For Docker Hub images with a known tag, queries the Hub API for
 * `tag_last_pushed` (the actual push timestamp). For all other registries,
 * or as a fallback, reads the `Last-Modified` HTTP header from the manifest
 * GET response — the time the registry stored that content-addressed manifest,
 * which is the push time (best-effort; not guaranteed by the OCI Distribution
 * spec).
 *
 * Returns null for private registries (anonymous auth rejected), unreachable
 * registries, or registries that do not expose a push timestamp.
 */
export async function fetchImagePublishDate(
  registry: string,
  repository: string,
  digest: string,
  tag: string | null = null,
): Promise<Date | null> {
  const host = resolveOciHost(registry);

  try {
    // Docker Hub exposes tag_last_pushed via the Hub web API — the real push time
    if ((registry === "docker.io" || registry === "index.docker.io") && tag) {
      const date = await dockerHubPushDate(repository, tag);
      if (date) return date;
    }

    // Universal fallback: Last-Modified on the manifest response = push time
    const token = await getOciToken(host, repository);

    const manifest = await fetchOciManifest(host, repository, digest, token);
    if (!manifest) return null;

    const mediaType = manifest.contentType.split(";")[0].trim();

    if (OCI_INDEX_MEDIA_TYPES.has(mediaType)) {
      // Multi-arch index: drill into preferred child and use its Last-Modified
      const index = manifest.body as {
        manifests?: Array<{
          digest: string;
          platform?: { os?: string; architecture?: string };
        }>;
      };
      if (!index.manifests?.length) return null;

      const child = selectManifestChild(index.manifests);
      if (!child?.digest) return null;

      const childManifest = await fetchOciManifest(
        host,
        repository,
        child.digest,
        token,
      );
      if (!childManifest) return null;
      return parseLastModified(childManifest.lastModified);
    }

    return parseLastModified(manifest.lastModified);
  } catch {
    return null;
  }
}

async function fetchOciBlobJson(
  host: string,
  repository: string,
  digest: string,
  token: string | null,
): Promise<unknown | null> {
  // Guard against injection in the blob path. The digest here comes from within a
  // manifest body, but that manifest could be served by an attacker-controlled
  // registry (referenced from a PR-authored manifest). We require the algorithm
  // prefix and alphanumeric-only content to block path/query injection characters
  // (`?`, `#`, `/`, `%`, spaces) without enforcing exact OCI hex length (which
  // would break test fixtures that use abbreviated digests).
  if (!LOOSE_DIGEST_RE.test(digest)) return null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const result = await fetchWithRetry<unknown>(`https://${host}/v2/${repository}/blobs/${digest}`, headers);
  return result.kind === "ok" ? result.data : null;
}

/**
 * Fetch metadata labels for a container image, merging OCI manifest annotations
 * and config-blob Labels. Sources (lowest → highest precedence):
 *   1. index-level annotations (when top manifest is a multi-arch image index)
 *   2. chosen child-descriptor annotations (per-platform entry in the index)
 *   3. resolved image manifest top-level annotations
 *   4. config-blob config.Labels
 * Returns the merged map if any key is present, or null on total failure.
 * Works anonymously on public registries; private registries → null.
 */
export async function fetchImageLabels(
  registry: string,
  repository: string,
  reference: string,
): Promise<Record<string, string> | null> {
  const host = resolveOciHost(registry);
  try {
    const token = await getOciToken(host, repository);
    let manifest = await fetchOciManifest(host, repository, reference, token);
    if (!manifest) return null;

    const merged: Record<string, string> = {};

    const mediaType = manifest.contentType.split(";")[0].trim();
    if (OCI_INDEX_MEDIA_TYPES.has(mediaType)) {
      const index = manifest.body as {
        manifests?: Array<{
          digest: string;
          annotations?: Record<string, string>;
          platform?: { os?: string; architecture?: string };
        }>;
        annotations?: Record<string, string>;
      };
      // 1. index-level annotations
      Object.assign(merged, index.annotations ?? {});

      if (!index.manifests?.length) return Object.keys(merged).length ? merged : null;

      const child = selectManifestChild(index.manifests);
      if (!child?.digest) return Object.keys(merged).length ? merged : null;

      // 2. child-descriptor annotations
      Object.assign(merged, child.annotations ?? {});

      manifest = await fetchOciManifest(host, repository, child.digest, token);
      if (!manifest) return Object.keys(merged).length ? merged : null;
    }

    // 3. image manifest annotations
    const manifestBody = manifest.body as {
      config?: { digest?: string };
      annotations?: Record<string, string>;
    };
    Object.assign(merged, manifestBody.annotations ?? {});

    // 4. config-blob Labels (highest precedence — overrides annotations on conflict)
    const configDigest = manifestBody.config?.digest;
    if (configDigest) {
      const config = await fetchOciBlobJson(host, repository, configDigest, token);
      const cfg = config as { config?: { Labels?: Record<string, string> } } | null;
      Object.assign(merged, cfg?.config?.Labels ?? {});
    }

    return Object.keys(merged).length ? merged : null;
  } catch {
    return null;
  }
}

async function imageExistsOnHost(
  host: string,
  repository: string,
  reference: string,
): Promise<"found" | "notfound" | "unknown"> {
  try {
    const token = await getOciToken(host, repository);
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (token) headers.Authorization = `Bearer ${token}`;
    const safeRef = encodeOciReference(reference);
    if (safeRef === null) return "unknown"; // invalid digest format
    const result = await fetchHeadWithRetry(`https://${host}/v2/${repository}/manifests/${safeRef}`, headers);
    if (result.kind === "ok") return "found";
    if (result.kind === "not_found") return "notfound";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check whether a manifest reference exists in an OCI registry without
 * downloading its content. Uses a HEAD request per the OCI Distribution v2
 * spec.
 *
 * Returns:
 *   "found"    — HTTP 200 (manifest exists and is publicly accessible)
 *   "notfound" — HTTP 404 (reference does not exist in the registry)
 *   "unknown"  — any other status (401 private, 429 rate-limit, network
 *                error, or thrown exception) — caller should not treat the
 *                reference as either present or absent
 *
 * When `dockerhubMirror` is set and the primary check against Docker Hub
 * returns "unknown" (e.g. rate-limited), the mirror is tried as a fallback.
 * This lets CI environments that configure a Docker Hub mirror (e.g.
 * mirror.gcr.io) resolve ambiguous COPY --from / RUN --mount=from references
 * even when the primary registry is throttling anonymous requests.
 */
export async function imageExists(
  registry: string,
  repository: string,
  reference: string,
  dockerhubMirror?: string,
): Promise<"found" | "notfound" | "unknown"> {
  const host = resolveOciHost(registry);
  const result = await imageExistsOnHost(host, repository, reference);
  if (
    result === "unknown" &&
    (registry === "docker.io" || registry === "index.docker.io") &&
    dockerhubMirror
  ) {
    return imageExistsOnHost(dockerhubMirror, repository, reference);
  }
  return result;
}

// ─── List-versions helpers (used by updater) ─────────────────────────────────

/**
 * Shared fetch-and-parse helper for listing package versions with publish dates.
 * Handles the common skeleton: fetch → guard → extract → sort → catch.
 */
async function listVersions<TData>(
  url: string,
  headers: Record<string, string> | undefined,
  extract: (data: TData) => Array<{ version: string; publishDate: Date | null }>,
  label: string,   // for warning messages, e.g. "npm:react"
): Promise<Array<{ version: string; publishDate: Date | null }>> {
  const result = await fetchWithRetry<TData>(url, headers);
  // 404/410 → genuine "no versions published" (empty is correct; caller skips).
  if (result.kind === "not_found") return [];
  // Transient failures (rate-limit, 5xx, network) → throw so the caller (runBatched)
  // logs a warning and skips this dep, rather than silently implying it is current.
  // Mirrors mavenMetadataVersions which already throws on "all repos unreachable".
  if (result.kind !== "ok") {
    throw new Error(
      `${label}: registry fetch failed (${result.kind}): ` +
      `${result.kind === "error" ? result.message : result.kind}`,
    );
  }
  const entries = extract(result.data);
  return entries.sort((a, b) => compareVersionsDesc(a.version, b.version, true));
}

// Singleton XML parser for Maven metadata — matches license.ts singleton pattern.
// parseTagValue/parseAttributeValue disabled so numeric-looking versions like
// "4.10" are preserved as strings (not coerced to the number 4.1).
const mavenXmlParser = new XMLParser({ parseTagValue: false, parseAttributeValue: false, processEntities: false });

interface MavenMetadata {
  metadata?: {
    versioning?: {
      latest?: string;
      // Elements are typed `unknown` (not `string`) because a `<version>` element carrying
      // an XML attribute parses to an object ({ "#text": ..., "@_...": ... }) rather than a
      // bare string — the `as MavenMetadata` cast doesn't validate this at runtime.
      versions?: { version?: unknown | unknown[] };
    };
  };
}

/**
 * Extract the textual content of a parsed maven-metadata.xml `<version>` element,
 * which is a plain string in the common case but an object with a `#text` key when
 * the element carries an XML attribute (parseAttributeValue is disabled, so attributed
 * elements come back as `{ "#text": "1.2.3", "@_...": ... }` rather than a bare string).
 */
function mavenVersionText(v: unknown): string {
  if (v !== null && typeof v === "object" && "#text" in v) {
    return String((v as { "#text": unknown })["#text"]);
  }
  return String(v);
}

/**
 * Returns true when any numeric segment of a semver string exceeds
 * Number.MAX_SAFE_INTEGER. semver.coerce() converts segments via Number(),
 * which loses precision beyond that bound — e.g. a 17-digit segment silently
 * becomes 0 and the version sorts last instead of first.
 */
function hasOverflowingSegment(v: string): boolean {
  return v.split(/[\s+\-.]/).some(
    (seg) => /^\d+$/.test(seg) && !Number.isSafeInteger(Number(seg)),
  );
}

/**
 * Normalize leading zeros in each numeric segment before coercing so that
 * "2.00" → "2.0" and coerces correctly instead of returning undefined.
 * Uses (^[vV]?|[.\s+\-]) so a leading "v" in "v01.2.3" is included in the
 * captured prefix ($1) rather than forming a word-char boundary that blocks
 * the match — /\b/ would fail between [vV] and the following zero.
 */
function normalizeLeadingZeros(v: string): string {
  return v.replace(/(^[vV]?|[.\s+-])0+([0-9])/g, "$1$2");
}

/**
 * Returns the semver-coerced form of `v` when it is usable for comparison/sorting
 * under `compareVersionsDesc(..., useCoerce: true)`, or null when it is not —
 * either because a numeric segment overflows Number.MAX_SAFE_INTEGER (see
 * hasOverflowingSegment) or because semver.coerce cannot parse it at all.
 *
 * This is the single source of truth for "is this version comparable" shared by
 * compareVersionsDesc and any pre-sort filter (e.g. bcrVersions). Filtering with a
 * looser check (like a bare `semver.coerce(v) !== null`) would let an
 * overflowing-segment version survive the filter while compareVersionsDesc treats
 * it as non-comparable and sorts it last — the two disagreeing means a garbage
 * version could end up first in the filtered array (before the explicit sort even
 * runs its overflow handling) or otherwise be mis-selected as "latest".
 */
function coercedComparableVersion(v: string): string | null {
  if (hasOverflowingSegment(v)) return null;
  return semver.coerce(normalizeLeadingZeros(v))?.version ?? null;
}

/**
 * Compare two version strings for descending sort (newest first).
 * When `useCoerce` is false (default), uses strict semver.valid — versions that
 * aren't valid semver fall to the end in their original order.
 * When `useCoerce` is true, uses semver.coerce so 2-segment Maven versions
 * ("4.13", "3.0-rc5", "2.21.RELEASE") sort correctly alongside full semver.
 * Note: coerce is lossy for qualifiers (e.g. "2.21.RELEASE" → "2.21.0"), so
 * two versions whose base is identical (e.g. "2.21.0" and "2.21.RELEASE") may
 * sort arbitrarily; the downstream per-version age/existence gate is the backstop.
 *
 * Versions with segments >9 digits are treated as non-comparable (fall to the end)
 * because semver.coerce() overflows them to 0.0.0, mis-ranking them as oldest.
 */
export function compareVersionsDesc(a: string, b: string, useCoerce = false): number {
  const av = useCoerce ? coercedComparableVersion(a) : semver.valid(a);
  const bv = useCoerce ? coercedComparableVersion(b) : semver.valid(b);
  if (av && bv) {
    const cmp = semver.rcompare(av, bv) as number;
    // Coercion is lossy for qualified Maven versions (e.g. "2.21.RELEASE" → "2.21.0"),
    // so two distinct inputs can coerce equal. Break the tie deterministically:
    // prefer the stable form (digits+dots only) over a qualified form, then fall
    // back to lexical descending so the sort is a total order, not arbitrary.
    if (cmp !== 0) return cmp;
    const aIsStable = /^[\d.]+$/.test(a);
    const bIsStable = /^[\d.]+$/.test(b);
    if (aIsStable !== bIsStable) return aIsStable ? -1 : 1; // stable sorts newer
    return b > a ? 1 : b < a ? -1 : 0; // existing lexical tiebreak as last resort
  }
  if (av) return -1;
  if (bv) return 1;
  // Neither version coerces — sort deterministically by raw string (descending) so the
  // result is a total order regardless of V8 sort stability or input ordering.
  return b > a ? 1 : b < a ? -1 : 0;
}

/**
 * List all non-prerelease versions of an npm package, sorted newest first.
 * Reuses the same registry endpoint as npmPublishDate.
 */
export async function npmVersions(
  name: string,
  registries: RegistryUrls,
): Promise<Array<{ version: string; publishDate: Date | null }>> {
  type NpmData = { time?: Record<string, string>; versions?: Record<string, unknown> };
  return listVersions<NpmData>(
    `${registries.npm}/${name}`,
    undefined,
    (data) => {
      if (!data.time) return [];
      // Only filter against `versions` when it is present. Some private/mirror npm
      // registries return a slimmed packument with `time` but no `versions` map —
      // filtering on an empty set would silently produce no results and cause the
      // verify action to report `unknown` instead of the real publish date (fail-closed
      // but a coverage regression). When `versions` is absent, trust `time` directly.
      const publishedVersionSet = data.versions !== undefined
        ? new Set(Object.keys(data.versions))
        : null;
      if (publishedVersionSet === null && !_warnedNpmNoVersionsField.has(registries.npm)) {
        _warnedNpmNoVersionsField.add(registries.npm);
        core.warning(
          `[lisan] npm registry ${registries.npm} returned a packument without a "versions" field — ` +
          `age dates are from the "time" map only; a hostile mirror could backdate versions.`,
        );
      }
      const results: Array<{ version: string; publishDate: Date | null }> = [];
      for (const [version, dateStr] of Object.entries(data.time)) {
        // Skip npm registry metadata keys ("created", "modified").
        if (version === "created" || version === "modified") continue;
        if (publishedVersionSet !== null && !publishedVersionSet.has(version)) continue; // version was unpublished
        // When `versions` is absent (slimmed packument / mirror registry), trust only
        // strict semver release versions. The `time` object may include prerelease
        // entries, `unpublished` tombstones, and — for a malicious mirror — backdated
        // injected versions. A release-only filter limits the promotion trust boundary
        // without affecting the common case (npmjs.org always returns `versions`).
        if (publishedVersionSet === null && !semver.valid(version)) continue;
        const publishDate = sanePublishDate(dateStr);
        // Skip entries with malformed or out-of-range dates (NaN, pre-2000, far-future).
        if (publishDate === null) continue;
        results.push({ version, publishDate });
      }
      return results;
    },
    `npm:${name}`,
  );
}

/**
 * List all non-yanked versions of a crates.io crate, sorted newest first.
 * Reuses the same registry endpoint as cratesPublishDate.
 */
export async function cratesVersions(
  name: string,
  registries: RegistryUrls,
): Promise<Array<{ version: string; publishDate: Date | null }>> {
  type CratesData = { versions?: Array<{ num: string; created_at?: string; yanked?: boolean }> };
  return listVersions<CratesData>(
    `${registries.crates}/api/v1/crates/${name}`,
    { "User-Agent": "lisan-al-gaib-action" },
    (data) => {
      if (!data.versions) return [];
      const results: Array<{ version: string; publishDate: Date | null }> = [];
      for (const v of data.versions) {
        if (v.yanked) continue;
        if (!v.created_at) continue;
        const publishDate = sanePublishDate(v.created_at);
        if (publishDate === null) continue;
        results.push({ version: v.num, publishDate });
      }
      return results;
    },
    `crates:${name}`,
  );
}

/**
 * List available versions of a Maven artifact from maven-metadata.xml.
 * For each repository, fetches the metadata XML and parses the version list.
 * All versions are returned with publishDate: null — dates are resolved lazily
 * per-version via mavenPublishDate. Versions are sorted semver-desc (newest
 * first) so resolveLatest can walk them without trusting XML document order.
 * semver.coerce is used for the comparison so 2-segment ("4.13") and
 * qualified ("2.21.RELEASE", "3.0-rc5") Maven forms sort correctly;
 * only strings that cannot be coerced at all fall to the end.
 */
export async function mavenMetadataVersions(
  group: string,
  artifact: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<Array<{ version: string; publishDate: Date | null }>> {
  const groupPath = group.replace(/\./g, "/");
  let anyRepoReachable = false;

  // Collect version lists from ALL configured repos rather than stopping at the first
  // that responds. An artifact may be split across a private mirror and Maven Central —
  // taking only the first responding repo's list can miss newer versions from a later
  // repo, or suggest a downgrade to a version that exists only in that first repo.
  const allVersionLists: Array<Array<{ version: string; publishDate: Date | null }>> = [];

  for (const repo of repositories) {
    const base = requireHttpsMavenRepo(resolveMavenRepo(repo, registries));
    if (base === null) {
      // SSRF-prevention skip (see requireHttpsMavenRepo): otherwise indistinguishable
      // downstream from "this repo answered cleanly with no matching artifact", which
      // would silently drop coverage. Warn once per repo (not once per artifact lookup)
      // to surface the coverage loss without spamming a diff with many changed deps.
      if (!_warnedNonHttpsMavenRepo.has(repo)) {
        _warnedNonHttpsMavenRepo.add(repo);
        core.warning(
          `[lisan] Skipping non-HTTPS Maven repository "${repo}" — only HTTPS repository URLs are queried ` +
          `(SSRF prevention). Versions hosted only in this repo will not be considered.`,
        );
      }
      continue;
    }

    const metadataUrl = `${base}/${groupPath}/${artifact}/maven-metadata.xml`;

    // Use fetchTextWithRetry so transient 5xx / 429 responses are retried with
    // exponential backoff, consistent with every other body-returning GET in this file.
    // Returns a discriminated FetchResult<string>: ok / not_found / rate_limited / error,
    // so 404 (artifact absent — repo reachable) is distinguished from network failure
    // (unreachable) without a separate HEAD probe.
    let textResult: Awaited<ReturnType<typeof fetchTextWithRetry>>;
    try {
      textResult = await fetchTextWithRetry(metadataUrl);
    } catch {
      continue; // unexpected error — try next repo
    }

    if (textResult.kind === "not_found") {
      // 404/410: repo answered but doesn't host this artifact — mark reachable, skip.
      anyRepoReachable = true;
      continue;
    }
    if (textResult.kind !== "ok") {
      // rate_limited or error (5xx / network) after all retries — repo unreachable.
      continue;
    }
    anyRepoReachable = true;

    let parsed: MavenMetadata;
    try {
      parsed = mavenXmlParser.parse(textResult.data) as MavenMetadata;
    } catch {
      // Malformed XML — treat as "no versions from this repo".
      continue;
    }
    const versioning = parsed.metadata?.versioning;
    if (!versioning) continue;

    // Parse version list. With parseTagValue disabled the parser keeps numeric-looking
    // versions ("4.10") as strings; mavenVersionText additionally unwraps the
    // { "#text": ... } shape produced for attributed <version> elements.
    const rawVersions = versioning.versions?.version;
    let versionList: string[] = [];
    if (Array.isArray(rawVersions)) {
      versionList = rawVersions.map(mavenVersionText);
    } else if (rawVersions !== undefined && rawVersions !== null) {
      versionList = [mavenVersionText(rawVersions)];
    }

    // Pre-filter: keep only versions whose leading numeric run is immediately followed
    // by a version separator (`.`, `-`, `+`), whitespace, or end-of-string.
    // This rejects digit-prefixed junk like `"4abc"` (which `semver.coerce` would
    // coerce to `4.0.0`, letting it silently outrank real versions) while preserving
    // legitimate Maven qualifiers like `2.21.RELEASE`, `3.0-rc5`, `1.20`, `2.00`.
    // `v`-prefixed strings are excluded (Maven coordinates never carry a `v` prefix).
    // We intentionally do NOT gate on `semver.coerce !== null` — leading-zero minor
    // versions like `"2.00"` are valid Maven versions but `semver.coerce` may reject them.
    const MAVEN_VERSION_RE = /^\d+([.\-+]|\s|$)/;
    versionList = versionList.filter((v) => MAVEN_VERSION_RE.test(v));

    if (versionList.length > 0) {
      allVersionLists.push(versionList.map((v) => ({ version: v, publishDate: null })));
    }
  }

  if (allVersionLists.length === 0) {
    // Distinguish "artifact has no versions in any repo" (some repo answered 404/410)
    // from a transient outage where every repo was unreachable — callers should not
    // treat the latter as a definitive empty version list. `anyRepoReachable` is only
    // ever set to true inside the loop above after a repo passed requireHttpsMavenRepo,
    // so this also covers "every configured repo was skipped for being non-HTTPS": that
    // case must throw here rather than silently returning [], same as a network outage.
    if (!anyRepoReachable) {
      throw new Error(`all Maven repos unreachable for ${group}:${artifact}`);
    }
    return [];
  }

  // Union version sets across all repos: deduplicate by version string, then sort
  // semver-descending so resolveLatest walks newest-first.
  // Use coerce so 2-segment Maven versions ("4.13", "3.0-rc5", "2.21.RELEASE")
  // sort correctly alongside full semver (coerce is lossy for qualifiers — see compareVersionsDesc JSDoc).
  const seen = new Set<string>();
  const unified: Array<{ version: string; publishDate: Date | null }> = [];
  for (const list of allVersionLists) {
    for (const entry of list) {
      if (!seen.has(entry.version)) {
        seen.add(entry.version);
        unified.push(entry);
      }
    }
  }
  unified.sort((a, b) => compareVersionsDesc(a.version, b.version, true));
  return unified;
}

/**
 * List all versions of a Bazel Central Registry module.
 * Only the latest version gets a publish date (via bcrPublishDate); others get null.
 * Sorted newest semver first.
 */
export async function bcrVersions(
  name: string,
  token: string,
  bcrUrl: string,
): Promise<Array<{ version: string; publishDate: Date | null }>> {
  try {
    const url = `${bcrUrl.replace(/\/$/, "")}/modules/${encodeURIComponent(name)}/metadata.json`;
    const result = await fetchWithRetry<{ versions?: string[] }>(url);
    if (result.kind === "not_found") return []; // module genuinely absent from BCR
    if (result.kind !== "ok") {
      // rate_limited or error after exhausting retries — transient failure. Throw (not a
      // silent []) so the caller's fail-closed path (runBatched → core.warning) makes the
      // outage visible, instead of reporting "module is up to date" when it was never checked.
      throw new Error(`BCR metadata unreachable for ${name}: ${result.kind}`);
    }
    if (!result.data.versions?.length) return [];

    // Sort versions newest semver first; use coerce (not valid) so non-strict-semver BCR
    // releases ("1.0-rc1", date-style modules) aren't silently dropped.
    // Filter with the exact same predicate compareVersionsDesc(..., true) uses to decide
    // "comparable" (coercedComparableVersion) — a looser `semver.coerce(v) !== null` check
    // here would let an overflowing-segment version (a malformed/fuzzed BCR metadata.json
    // entry, e.g. a 17+ digit numeric segment) survive the filter while the comparator
    // treats it as non-comparable, risking it being mis-picked as "latest".
    const sorted = [...result.data.versions]
      .filter((v) => coercedComparableVersion(v) !== null)
      .sort((a, b) => compareVersionsDesc(a, b, true));
    if (sorted.length === 0) return [];

    const latest = sorted[0];
    const latestDate = await bcrPublishDate(name, latest, token, bcrUrl);

    return sorted.map((version) => ({
      version,
      publishDate: version === latest ? latestDate : null,
    }));
  } catch (err) {
    // On unexpected errors (network failure, malformed metadata), warn and return [] so
    // the updater fails closed (no candidate suggested for this module rather than
    // crashing the whole run). Use core.warning (not console.warn) so BCR unreachability
    // surfaces as a GitHub Actions annotation, matching Maven's throw→runBatched→warning path.
    core.warning(`bcr: metadata fetch failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Resolve an OCI image tag to its manifest digest (sha256:...).
 * Uses a direct HEAD request per OCI Distribution v2 spec to read the
 * Docker-Content-Digest response header without downloading manifest content.
 * Returns null if the tag cannot be resolved or the registry is unavailable.
 */
/**
 * Resolve the content-digest of `tag` in the given OCI registry.
 *
 * When `dockerhubMirror` is set and the registry is Docker Hub and the primary
 * manifest HEAD request fails (any non-200 including a 429 rate-limit), the
 * mirror is tried as a fallback — mirroring the existing `imageExists` mirror
 * strategy so updater and verify behave consistently under rate-limiting.
 */
export async function ociDigestForTag(
  registry: string,
  repository: string,
  tag: string,
  dockerhubMirror?: string,
): Promise<string | null> {
  const isDockerHub = registry === "docker.io" || registry === "index.docker.io";
  const primaryHost = resolveOciHost(registry);

  async function tryHost(host: string): Promise<string | null> {
    try {
      const token = await getOciToken(host, repository);
      const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
      if (token) headers.Authorization = `Bearer ${token}`;

      const result = await fetchHeadWithRetry(
        `https://${host}/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
        headers,
      );
      if (result.kind !== "ok") return null;

      const digest = result.data.headers.get("Docker-Content-Digest");
      // Validate format before trusting a value from an external registry.
      // Reuse the shared DIGEST_RE instead of an inline copy.
      return DIGEST_RE.test(digest ?? "") ? digest : null;
    } catch {
      return null;
    }
  }

  const result = await tryHost(primaryHost);
  if (result !== null) return result;

  // Primary failed: try the mirror if this is Docker Hub and a mirror is configured.
  if (isDockerHub && dockerhubMirror) {
    return tryHost(dockerhubMirror);
  }
  return null;
}
