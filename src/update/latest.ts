import * as core from "@actions/core";
import semver from "semver";
import {
  npmVersions,
  cratesVersions,
  mavenMetadataVersions,
  mavenPublishDate,
  bcrVersions,
  bcrPublishDate,
  githubApiFetch,
  compareVersionsDesc,
  sanePublishDate,
} from "../registry.js";
import { parseImageRef, ociTagOf, resolveImageDigestAndAge } from "../ecosystems/image.js";
import { computeAgeDays, meetsMinAge } from "../age.js";
// Re-export so existing importers (and tests) can keep importing it from here.
export { computeAgeDays };
import { DEFAULT_REGISTRIES } from "../inputs.js";
import type { RegistryUrls } from "../inputs.js";
import type { AllowDowngrade, DepRef, LicensePolicy, UpdateMode, VersionInfo } from "./types.js";
import type { ECOSYSTEM_REGISTRY } from "./ecosystem-registry.js";
import { isLicenseMoreRestrictiveThan } from "../license.js";

/** Strip a subpath from an owner/repo[/subpath] string → "owner/repo". */
export function ownerRepoOf(name: string): string {
  return name.split("/").slice(0, 2).join("/");
}

export interface ResolveLatestOpts {
  mode: UpdateMode;
  minAgeDays: number;
  token: string;
  registries: RegistryUrls;
  javaRepositories?: string[];  // for java ecosystem
  bcrUrl?: string;              // for bazel ecosystem, default "https://bcr.bazel.build"
  dockerhubMirror?: string;     // Docker Hub mirror tried as fallback on rate-limit during digest resolution
  /** Downgrade policy — propagated to resolveLazy so it can collect the full version list when
   *  a downgrade target may exist (vs. the fast "break after first qualifying" path for "no"). */
  allowDowngrade?: AllowDowngrade;
}

// Tokens that indicate a stable (non-prerelease) release qualifier.
// Maven uses suffixes like .RELEASE, .Final, .GA, .SP1 for stable releases.
const STABLE_QUALIFIER_RE = /^(?:release|final|ga|sp\d*)$/i;

// Tokens that indicate a prerelease qualifier (keyword list + any trailing digits).
// Note: "r" is intentionally excluded — Alpine packaging-revision suffixes like
// -r0/-r3 are stable rebuild revisions, not software prereleases.
const PRERELEASE_QUALIFIER_RE =
  /^(?:alpha|beta|rc|cr|pre|preview|dev|snapshot|nightly|canary|milestone|eap|m|a|b)\d*$/i;

/**
 * Returns true if `v` is a prerelease version.
 *
 * For all version strings — both valid semver and non-semver — we tokenise
 * the qualifier suffix and match against keyword lists:
 *   - a STABLE token (release/final/ga/sp…) → stable (false)
 *   - a numeric token → prerelease (true) — indicates a build counter like 1.0.0-0
 *   - a PRERELEASE keyword token → prerelease (true)
 *   - no recognisable qualifier → treated as stable (false, conservative)
 *
 * We do NOT rely on semver.prerelease() !== null because that function treats any
 * hyphen-separated suffix as a prerelease identifier, which would misclassify OCI
 * image flavor tags like "1.24.0-alpine" and "3.11.6-slim-bullseye" as prerelease.
 */
export function isPrerelease(v: string): boolean {
  if (semver.valid(v)) {
    const pre = semver.prerelease(v);
    if (!pre) return false;
    for (const token of pre) {
      if (typeof token === "number") return true;  // numeric build counter → prerelease
      if (STABLE_QUALIFIER_RE.test(token)) return false;
      if (PRERELEASE_QUALIFIER_RE.test(token)) return true;
    }
    return false;  // unrecognised identifier (e.g. "alpine", "slim") → treat as stable
  }
  // Strip leading "v"/"V" and build-metadata (+…)
  const stripped = v.replace(/^[vV]/, "").replace(/\+.*$/, "");
  // Extract the numeric core and the remaining qualifier
  const match = /^(\d+(?:\.\d+){0,2})(.*)$/.exec(stripped);
  if (!match) return false;
  const qualifier = match[2];
  if (!qualifier) return false;
  // Tokenise on separator chars
  const tokens = qualifier.split(/[-._]+/).filter(Boolean);
  for (const token of tokens) {
    if (STABLE_QUALIFIER_RE.test(token)) return false;  // .RELEASE / .Final etc.
    if (PRERELEASE_QUALIFIER_RE.test(token)) return true;
  }
  return false;
}

/**
 * Returns the `major.minor.patch` base of a version string (as a normalised
 * semver string), or null when the version cannot be coerced.
 * Used to compare the base of two prerelease versions.
 */
export function versionBase(v: string): string | null {
  return semver.coerce(v)?.version ?? null;
}

/**
 * Returns true when promoting `current → target` passes the stability gate:
 *   - A stable target is always allowed.
 *   - A prerelease target is only allowed when `current` is itself a prerelease
 *     AND the two versions share the same major.minor.patch base
 *     (e.g. 1.0.0-alpha.1 → 1.0.0-alpha.2 is fine; 2.3.4 → 3.0.0-rc5 is not).
 */
export function passesStabilityGate(current: string, target: string): boolean {
  if (!isPrerelease(target)) return true;
  if (!isPrerelease(current)) return false;
  const cb = versionBase(current);
  const tb = versionBase(target);
  return cb !== null && tb !== null && cb === tb;
}

/**
 * Filter a list of VersionInfo entries, dropping any prerelease candidates
 * that are not allowed given the current version's stability level.
 */
export function filterByStability(
  versions: VersionInfo[],
  current: string,
): VersionInfo[] {
  return versions.filter((v) => passesStabilityGate(current, v.version));
}

/**
 * Returns the parallel-variant "flavor" of a version string, or null when the
 * version has no flavor.  A flavor is a purely-alphabetic qualifier token that
 * is not a Maven stable-release keyword (release/final/ga/sp).
 *
 * Examples:
 *   "33.5.0-jre"        → "jre"
 *   "33.6.0-android"    → "android"
 *   "1.24.0-alpine"     → "alpine"
 *   "33.6.0"            → null  (no qualifier)
 *   "1.0.0-rc1"         → null  (prerelease — rc1 contains a digit)
 *   "2.0.0.RELEASE"     → null  (stable keyword, not a variant flavor)
 *   "9.4.51.v20230217"  → null  (digit-bearing build qualifier — not a flavor)
 *
 * Prerelease versions (per isPrerelease) are always flavor-less — they do not
 * represent parallel stable release lines.
 */
export function versionFlavor(v: string): string | null {
  if (isPrerelease(v)) return null;
  const stripped = v.replace(/^[vV]/, "").replace(/\+.*$/, "");
  const match = /^(\d+(?:\.\d+){0,2})(.*)$/.exec(stripped);
  if (!match) return null;
  const qualifier = match[2];
  if (!qualifier) return null;
  const tokens = qualifier.split(/[-._]+/).filter(Boolean);
  const flavorTokens = tokens.filter(
    (t) => /^[a-z]+$/i.test(t) && !STABLE_QUALIFIER_RE.test(t),
  );
  if (flavorTokens.length === 0) return null;
  return flavorTokens.map((t) => t.toLowerCase()).join("-");
}

/**
 * Filter candidates to those matching the current version's flavor.
 * If the current version has no flavor (versionFlavor returns null), all
 * candidates are returned unchanged — no constraint is applied.
 */
export function filterByFlavor(
  versions: VersionInfo[],
  current: string,
): VersionInfo[] {
  const flavor = versionFlavor(current);
  if (flavor === null) return versions;
  return versions.filter((v) => versionFlavor(v.version) === flavor);
}

/**
 * Normalize a version string for semver comparison: strict semver is used as-is,
 * otherwise falls back to semver.coerce (e.g. "1.21", "v3" → "1.21.0", "3.0.0").
 * Returns null when the string can't be coerced to semver at all.
 *
 * Single-sourced so classifyUpdateLevel and filterByMode can't drift on how they
 * coerce non-strict tags (container/action version tags rarely use strict semver).
 */
function normalizeForCompare(v: string): string | null {
  return semver.valid(v) ?? semver.coerce(v)?.version ?? null;
}

/**
 * Classify the update level between two semver strings.
 * Returns "major", "minor", or "patch".
 * For prerelease variants, maps to the base type (e.g. "premajor" → "major").
 * If either version is not valid semver, returns "major" as a conservative default.
 */
export function classifyUpdateLevel(
  current: string,
  latest: string,
): "major" | "minor" | "patch" {
  // Coerce non-strict tags (e.g. "1.21", "v3") so two-part container/action tags
  // classify by their real delta instead of defaulting to "major" (breaking).
  const c = normalizeForCompare(current);
  const l = normalizeForCompare(latest);
  if (!c || !l) {
    return "major";
  }

  const diff = semver.diff(c, l);
  if (!diff) return "patch";

  switch (diff) {
    case "major":
    case "premajor":
      return "major";
    case "minor":
    case "preminor":
      return "minor";
    case "patch":
    case "prepatch":
    case "prerelease":
      return "patch";
    default:
      return "major";
  }
}

/**
 * Filter a list of VersionInfo entries to only those allowed by the given mode.
 * - "patch": only patch-level changes
 * - "minor": patch and minor changes
 * - "major": all versions
 * If current is not valid semver, all versions are returned.
 *
 * Delegates to {@link classifyUpdateLevel} (rather than inspecting raw
 * `semver.diff` output directly) so magnitude classification is single-sourced
 * and direction-aware: `semver.diff` itself is symmetric (it grades by which
 * component differs, not by which argument is numerically larger), so a
 * downgrade candidate is graded by the magnitude of the step DOWN the same
 * way an equivalent-magnitude upgrade would be graded. This matters for
 * `--allow-downgrade only`, where downgrade candidates flow through this same
 * filter — without delegating here, a duplicated inline classification could
 * drift from classifyUpdateLevel's mapping (e.g. its "same version → patch"
 * and "unparseable → major" conventions) and misclassify downgrade magnitude.
 */
export function filterByMode(
  versions: VersionInfo[],
  current: string,
  mode: UpdateMode,
): VersionInfo[] {
  if (mode === "major") return versions;
  // Coerce non-strict tags (e.g. "v3", "1.21") so --mode patch/minor applies to
  // container and action version tags that don't use strict semver.
  const normalizedCurrent = normalizeForCompare(current);
  if (!normalizedCurrent) return versions;

  return versions.filter((v) => {
    const normalizedV = normalizeForCompare(v.version);
    if (!normalizedV) return false;
    const level = classifyUpdateLevel(normalizedCurrent, normalizedV);
    if (mode === "patch") return level === "patch";
    // mode === "minor"
    return level === "patch" || level === "minor";
  });
}

/**
 * Filter a list of VersionInfo entries to only those that have met the minimum
 * age requirement. Fail-closed: versions with null ageDays (unknown publish
 * date) are EXCLUDED — suggesting an unverifiable version would defeat the
 * age gate.
 */
export function applyAgeGate(
  versions: VersionInfo[],
  minAgeDays: number,
): VersionInfo[] {
  // meetsMinAge is fail-closed: null ageDays (unconfirmable date) always excluded.
  return versions.filter((v) => meetsMinAge(v.ageDays, minAgeDays));
}

/**
 * Result of paginated GitHub Actions release listing.
 * `partial: true` indicates a page returned a non-ok result (rate-limit, auth,
 * network) before pagination completed — the accumulated `versions` list may be
 * truncated, so callers must skip the dep rather than trust a partial list.
 */
interface ActionsVersionsResult {
  partial: boolean;
  versions: Array<{ version: string; publishDate: Date | null }>;
}

/**
 * Fetch a list of available GitHub Actions releases for the given owner/repo.
 * Paginates up to 2 pages of 30 results, sorted newest first.
 * Two pages of 30 is more than enough for the typical GitHub Action (v1 scope limit).
 */
async function actionsVersions(
  ownerRepo: string,
  token: string,
): Promise<ActionsVersionsResult> {
  // Strip subpath (e.g. "actions/checkout/.github" → "actions/checkout")
  const repo = ownerRepoOf(ownerRepo);

  const results: Array<{ version: string; publishDate: Date | null }> = [];

  for (let page = 1; page <= 2; page++) {
    const result = await githubApiFetch(
      `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`,
      token,
    );
    // A non-ok page (rate-limit/auth/error) means we cannot trust the list as
    // complete — signal partial so the caller skips the dep instead of bumping
    // it from a truncated set.
    if (result.kind === "not_found") break; // genuine: repo has no releases endpoint
    if (result.kind !== "ok") return { partial: true, versions: results };

    const data = result.data as Array<{ tag_name?: string; published_at?: string }>;
    if (!Array.isArray(data) || data.length === 0) break; // clean empty page → stop

    for (const release of data) {
      if (!release.tag_name) continue;
      results.push({
        version: release.tag_name,
        publishDate: sanePublishDate(release.published_at),
      });
    }

    if (data.length < 30) break; // last page reached
  }

  // Filter out null-dated releases (drafts, releases without published_at) before
  // sorting — they cannot be age-gated and, if left in, can sort to results[0]
  // via the stable-sort fallback and be mistaken for the newest release.
  const dated = results.filter((r) => r.publishDate !== null);

  // Already sorted newest first by GitHub API, but sort defensively.
  dated.sort((a, b) =>
    b.publishDate!.getTime() - a.publishDate!.getTime(),
  );

  return { partial: false, versions: dated };
}

/**
 * Translate a commit SHA to the unique version tag that points at it.
 * Paginates up to 3 pages of 100 tags. Returns the tag string when exactly
 * one version-parseable tag resolves to that SHA; returns null otherwise
 * (zero matches → no version info; >1 matches → ambiguous, e.g. "v4" + "v4.1.1").
 */
export async function shaToTag(
  ownerRepo: string,
  sha: string,
  token: string,
): Promise<string | null> {
  const repo = ownerRepoOf(ownerRepo);
  const matching: string[] = [];

  for (let page = 1; page <= 3; page++) {
    const result = await githubApiFetch(
      `https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`,
      token,
    );
    if (result.kind === "not_found") break; // genuine: no tags
    // A non-ok page (rate-limit/auth/error) means the tag list may be truncated;
    // returning a guess here could mis-pin a SHA, so bail out as "unknown".
    if (result.kind !== "ok") return null;
    const data = result.data as Array<{ name?: string; commit?: { sha?: string } }>;
    if (!Array.isArray(data) || data.length === 0) break;

    for (const tag of data) {
      if (tag.commit?.sha === sha && tag.name && semver.coerce(tag.name)) {
        matching.push(tag.name);
      }
    }

    if (data.length < 100) break;
  }

  return matching.length === 1 ? matching[0] : null;
}

/**
 * Returns true if `target` is an older (lower) version than `current`.
 * Uses strict semver comparison when both are valid semver; falls back to
 * semver.coerce for non-standard strings like "v3"/"v4".
 * Returns false (treat as upgrade) when direction cannot be determined.
 */
export function isDowngrade(current: string, target: string): boolean {
  // Try strict semver first
  if (semver.valid(current) && semver.valid(target)) {
    return semver.lt(target, current);
  }
  // Try coerced semver (handles "v3", "v4", etc.)
  const coercedCurrent = semver.coerce(current);
  const coercedTarget = semver.coerce(target);
  if (coercedCurrent && coercedTarget) {
    return semver.lt(coercedTarget, coercedCurrent);
  }
  // Unknown direction — treat as upgrade so it's never silently suppressed
  return false;
}

/**
 * Decide whether to keep a candidate version based on the allow-downgrade policy.
 * Returns the direction, whether the current version violates the age gate, and
 * whether this candidate should be kept in the list.
 */
export function decideDowngrade(args: {
  current: string;
  target: string;
  currentAgeDays: number | null;
  minAgeDays: number;
  allowDowngrade: AllowDowngrade;
}): { keep: boolean; direction: "upgrade" | "downgrade"; violatesAge: boolean } {
  const direction: "upgrade" | "downgrade" = isDowngrade(args.current, args.target)
    ? "downgrade"
    : "upgrade";
  const violatesAge = args.currentAgeDays !== null && args.currentAgeDays < args.minAgeDays;

  let keep: boolean;
  switch (args.allowDowngrade) {
    case "no":
      keep = direction === "upgrade";
      break;
    case "allow":
      keep = true;
      break;
    case "only":
      keep = direction === "downgrade";
      break;
  }

  return { keep, direction, violatesAge };
}

/**
 * Decide whether a version bump should be kept based on license permissiveness.
 * Returns whether the new license regresses (becomes more restrictive) vs current,
 * and whether the candidate should be kept.
 *
 * Fail-open for genuinely unknown licenses (null): if either license is unknown/null, the
 * candidate is always kept (both policies). However, when the new version's license could
 * NOT be confirmed due to a registry fetch error (`newLicenseFetchFailed: true`), the
 * `block` policy treats this as fail-closed — the update is held back rather than silently
 * promoted when the license may regress. The `warn` policy does not block on fetch errors
 * (it only warns on confirmed regressions).
 *
 * Both SPDX strings must already be normalized (spdxCorrect'd).
 */
export function decideLicense(args: {
  currentLicense: string | null;
  newLicense: string | null;
  policy: LicensePolicy;
  /** True when the new version's license fetch failed due to a transient registry error
   *  (distinct from null/unknown which means "no license declared by the registry"). */
  newLicenseFetchFailed?: boolean;
}): { keep: boolean; regresses: boolean; verified: boolean } {
  if (args.policy === "off") return { keep: true, regresses: false, verified: false };
  // Under block policy, a registry fetch error for the new version's license is treated as
  // fail-closed: we cannot confirm the license won't regress, so we hold the update back.
  // Under warn policy, a fetch error is not blocking — it's treated as unverified.
  if (args.newLicenseFetchFailed && args.policy === "block") {
    return { keep: false, regresses: false, verified: false };
  }
  if (!args.currentLicense || !args.newLicense) return { keep: true, regresses: false, verified: false };

  const regresses = isLicenseMoreRestrictiveThan(args.newLicense, args.currentLicense);
  const keep = args.policy === "warn" ? true : !regresses;
  return { keep, regresses, verified: true };
}

export interface ResolveResult {
  versions: VersionInfo[];
  currentAgeDays: number | null;
  /** When true: the dep's tag is pinned in place to its current digest (docker/kubernetes).
   *  Pin-in-place is exempt from the age gate — it adds immutability without changing versions. */
  pinInPlace?: boolean;
}

/**
 * Eager strategy: the fetcher returns a fully-dated version list (npm, crates,
 * actions). All entries already carry a publish date, so we compute ages up
 * front, fail-closed age-gate, then stability/mode-filter.
 */
async function resolveEager(
  fetcher: (
    name: string,
    eco: DepRef["ecosystem"],
    registries: RegistryUrls,
  ) => Promise<Array<{ version: string; publishDate: Date | null }>>,
  dep: DepRef,
  opts: ResolveLatestOpts,
): Promise<ResolveResult> {
  const { mode, minAgeDays, registries } = opts;
  const raw = await fetcher(dep.name, dep.ecosystem, registries);
  // De-duplicate by version string before computing ages/sorting — a hostile or
  // misbehaving mirror returning the same version twice (possibly with different
  // publish dates attached) could otherwise perturb downstream ordering/selection.
  // Keep the first occurrence, mirroring the dedup mavenMetadataVersions already
  // applies when unioning version lists across repos.
  const seenVersions = new Set<string>();
  const deduped = raw.filter((v) => {
    if (seenVersions.has(v.version)) return false;
    seenVersions.add(v.version);
    return true;
  });
  const withAge: VersionInfo[] = deduped.map((v) => ({
    version: v.version,
    publishDate: v.publishDate,
    ageDays: computeAgeDays(v.publishDate),
  }));
  const currentAgeDays = withAge.find((v) => v.version === dep.current)?.ageDays ?? null;
  const gated = applyAgeGate(withAge, minAgeDays);
  // Sort by semver descending so newer semver versions come first. Use coerce so
  // action tags like "v4.1.1" (rejected by semver.valid) sort correctly — without
  // it the comparator returns 0 for every pair and API publish-date order is kept,
  // which can surface a backported release as the "latest" and show a false
  // "up to date" when a genuine newer major exists.
  const sorted = [...gated].sort((a, b) => compareVersionsDesc(a.version, b.version, true));
  // Note: filterByFlavor is intentionally omitted for eager ecosystems (npm, crates,
  // actions) — their version namespaces are flat (no parallel variant lines like
  // "4.13.x" vs "4.14.x" within the same group/artifact), so flavor filtering adds
  // no value and would risk incorrectly suppressing valid candidates.
  return {
    versions: filterByMode(filterByStability(sorted, dep.current), dep.current, mode),
    currentAgeDays,
  };
}

/**
 * Lazy strategy: the fetcher returns versions with mostly-null publish dates
 * (java/bazel), so dates are resolved per-version on demand via `dateResolver`,
 * walking newest-first until the first version that meets the fail-closed age
 * gate is found. `filterByFlavor` keeps parallel variant lines on the same flavor.
 */
async function resolveLazy(
  fetcher: (
    group: string,
    artifact: string,
    repos: string[],
    registries: RegistryUrls,
  ) => Promise<Array<{ version: string; publishDate: Date | null }>>,
  dateResolver: (name: string, version: string, registries: RegistryUrls) => Promise<Date | null>,
  dep: DepRef,
  opts: ResolveLatestOpts,
  repos: string[],
): Promise<ResolveResult> {
  const { mode, minAgeDays, registries } = opts;
  // For java the fetcher needs group/artifact; for bazel the module name is a single
  // token and artifact is unused — we pass dep.name split on ":" (artifact "" for bazel).
  const [group, artifact] = dep.name.includes(":") ? dep.name.split(":") : [dep.name, ""];
  const candidates = await fetcher(group, artifact, repos, registries);
  if (candidates.length === 0) return { versions: [], currentAgeDays: null };

  // Resolve the current version's age for downgrade logic.
  // null conflates two cases: dep.current absent from candidates (version not in registry)
  // and dateResolver returning null (transient fetch failure). Both are safe for the age
  // gate (decideDowngrade treats null as "unknown → allow upgrade only") but suppress the
  // downgrade advisory when the current version is too new and would otherwise trigger it.
  const currentAgeDays = await (async () => {
    const entry = candidates.find((v) => v.version === dep.current);
    if (!entry) return null;
    if (entry.publishDate) return computeAgeDays(entry.publishDate);
    try {
      return computeAgeDays(await dateResolver(dep.name, dep.current, registries));
    } catch {
      // Transient registry failure while fetching the current version's age — null is safe
      // (only used by decideDowngrade for an advisory; must not suppress upgrade candidates).
      return null;
    }
  })();

  const withAge = candidates.map((v) => ({
    version: v.version,
    publishDate: v.publishDate,
    ageDays: computeAgeDays(v.publishDate),
  }));
  const modeFiltered = filterByMode(
    filterByStability(filterByFlavor(withAge, dep.current), dep.current),
    dep.current,
    mode,
  );

  const gated: VersionInfo[] = [];
  // When a downgrade is allowed (allow/only), we must inspect the full age-gated list so
  // buildCandidates can find the best lower-version target. For the default "no" policy,
  // break after the first qualifying version (the newest) to avoid N extra round-trips.
  const needFullList = opts.allowDowngrade !== undefined && opts.allowDowngrade !== "no";
  for (const v of modeFiltered) {
    let ageDays = v.ageDays;
    if (ageDays === null) {
      let resolvedDate: Date | null;
      try {
        resolvedDate = await dateResolver(dep.name, v.version, registries);
      } catch (err) {
        // Transient registry error — abort this dep rather than silently promoting an older version.
        core.warning(`[lisan] lazy date resolve failed for ${dep.name}@${v.version}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      ageDays = computeAgeDays(resolvedDate);
    }
    // meetsMinAge is fail-closed: versions whose date cannot be resolved are skipped.
    if (meetsMinAge(ageDays, minAgeDays)) {
      gated.push({ ...v, ageDays });
      if (!needFullList) break; // fast path: only the newest qualifying version is needed
    }
  }
  return { versions: gated, currentAgeDays };
}

/**
 * Main dispatcher: resolve available update versions for a dependency.
 * Returns viable update candidates (age-gated and mode-filtered), newest first,
 * along with the age in days of the currently-installed version (or null if unknown).
 *
 * For digest-less mutable OCI image refs (docker/kubernetes with no @sha256:
 * in dep.current), returns `pinInPlace: true` with `versions[0].version` set to
 * the current tag. The updater will pin the tag to its current digest instead of
 * bumping to a different tag.
 *
 * Pin-in-place requires the tag's age to meet the minAgeDays gate (fail-closed):
 * when the registry is unreachable or the publish date cannot be confirmed,
 * `currentAgeDays` is null and the candidate is skipped rather than promoted
 * (buildCandidates enforces this gate). The resolved digest is returned so
 * resolvePins can reuse it without a second round-trip (eliminating TOCTOU).
 */
// ECOSYSTEM_SYNC: keep in sync with ECOSYSTEM_DISPATCH in src/update/run.ts and lookupPublishDate switch in src/main.ts
export type CachedResolution = Awaited<ReturnType<typeof resolveLatest>>;

export async function resolveLatest(
  dep: DepRef,
  opts: ResolveLatestOpts,
): Promise<{ versions: VersionInfo[]; currentAgeDays: number | null; pinInPlace?: boolean; resolvedDigest?: string }> {
  const { token, registries } = opts;

  switch (dep.ecosystem) {
    case "npm":
      return resolveEager((name, _eco, regs) => npmVersions(name, regs), dep, opts);

    case "python":
      // Python updates are out of scope for v1
      return { versions: [], currentAgeDays: null };

    case "rust":
      return resolveEager((name, _eco, regs) => cratesVersions(name, regs), dep, opts);

    case "java": {
      const [group, artifact] = dep.name.split(":");
      if (!group || !artifact) return { versions: [], currentAgeDays: null };
      const repos = opts.javaRepositories?.length
        ? opts.javaRepositories
        : [registries.maven];  // fall back to configured Maven registry
      return resolveLazy(
        (g, a, reps, regs) => mavenMetadataVersions(g, a, reps, regs),
        (name, version, regs) => {
          const [g, a] = name.split(":");
          return mavenPublishDate(g, a, version, repos, regs);
        },
        dep,
        opts,
        repos,
      );
    }

    case "bazel": {
      const bcrUrl = opts.bcrUrl ?? DEFAULT_REGISTRIES.bcrUrl;
      return resolveLazy(
        (name) => bcrVersions(name, token, bcrUrl),
        (name, version) => bcrPublishDate(name, version, token, bcrUrl),
        dep,
        opts,
        [],
      );
    }

    case "actions": {
      const { partial, versions } = await actionsVersions(dep.name, token);
      if (partial) {
        // A page returned a non-ok result — the version list may be truncated.
        // Skip the whole dep rather than bumping from an incomplete set.
        core.warning(
          `actions: skipping ${dep.name} — could not fetch a complete release list ` +
          `(GitHub API rate-limited or unauthorized)`,
        );
        return { versions: [], currentAgeDays: null };
      }
      return resolveEager(async () => versions, dep, opts);
    }

    case "docker":
    case "kubernetes": {
      const ref = parseImageRef(dep.name);
      if (!ref) return { versions: [], currentAgeDays: null };

      // Always pin-in-place: preserve the author's tag and only manage the digest.
      // Stripping @digest gives the bare tag regardless of whether the ref was already
      // pinned; semver-bumping docker tags is unsafe because OCI tag naming conventions
      // don't follow semver and a bump would swap the image to an unrelated tag.
      const currentTag = ociTagOf(dep.current);

      // Single shared sequence: ociDigestForTag → fetchImagePublishDate → computeAgeDays.
      // resolveImageDigestAndAge is also used by run.ts resolvePins for the moved-tag
      // re-gate path, keeping both sides of verify+update on the same code path.
      let resolvedDigest: string | null = null;
      let currentAgeDays: number | null = null;
      if (currentTag) {
        const pinResult = await resolveImageDigestAndAge(
          ref.registry, ref.repository, currentTag, opts.dockerhubMirror,
        );
        resolvedDigest = pinResult.digest;
        if (!resolvedDigest) {
          // Private/unreachable registry or untagged ref — age unconfirmable.
          core.info(
            `${dep.ecosystem}: ${dep.name}:${currentTag} digest could not be resolved ` +
            `(private/unreachable registry); skipping pin`,
          );
        } else {
          if (pinResult.publishDate === null) {
            core.info(
              `${dep.ecosystem}: ${dep.name}:${currentTag} publish date unavailable (age unconfirmable)`,
            );
          }
          currentAgeDays = pinResult.ageDays;
        }
      }
      return {
        versions: currentTag ? [{ version: currentTag, publishDate: null, ageDays: currentAgeDays }] : [],
        currentAgeDays,
        pinInPlace: true,
        resolvedDigest: resolvedDigest ?? undefined,
      };
    }

    case "multitool":
      // Multitool binaries are URL-addressed; no registry version list is available.
      return { versions: [], currentAgeDays: null };

    default:
      return { versions: [], currentAgeDays: null };
  }
}

// Compile-time exhaustiveness guard: every ecosystem key in ECOSYSTEM_REGISTRY must have an
// explicit `case` in the resolveLatest switch above. If a new ecosystem is added to
// ECOSYSTEM_REGISTRY without a corresponding case, the Exclude below becomes non-never
// and TypeScript will flag this line as a type error.
// When adding a new ecosystem: (1) add the case to the switch, (2) extend the union here.
(null as unknown as Exclude<
  keyof typeof ECOSYSTEM_REGISTRY,
  "actions" | "docker" | "kubernetes" | "rust" | "java" | "bazel"
>) satisfies never;
