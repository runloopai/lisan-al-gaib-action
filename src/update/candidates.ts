import * as core from "@actions/core";
import * as clack from "@clack/prompts";
import { currentTagOf, wasUnpinnedRef } from "../ecosystems/image.js";
import { classifyUpdateLevel, decideDowngrade, isDowngrade, type CachedResolution } from "./latest.js";
import { meetsMinAge } from "../age.js";
import { resolveCacheKey } from "./cache-key.js";
import { shouldBypassAgeGate, formatAgeClause } from "./age-gate.js";
import type { AllowDowngrade, DepRef, UpdateCandidate } from "./types.js";
import type { RunOpts } from "./run.js";

/**
 * Build the initial UpdateCandidate list from resolved versions, applying the
 * downgrade policy and (interactively) logging skipped/downgrade decisions.
 * Also emits the `--allow-downgrade only` "no candidate" guidance warning.
 */
function warnNoDowngradeCandidates(
  filteredDeps: DepRef[],
  candidates: UpdateCandidate[],
  versionCache: Map<string, CachedResolution>,
  mode: string,
): void {
  // Warn when --allow-downgrade only is set but --mode filtering removed all
  // downgrade candidates for a dep (filterByMode in resolveLatest runs before
  // decideDowngrade, so it can silently produce an empty candidate set).
  // Only warn when the version cache actually contained lower versions — if the dep
  // is already at the lowest available version, a "no candidate" is expected and correct.
  for (const dep of filteredDeps) {
    const key = resolveCacheKey(dep.ecosystem, dep.name, dep.current);
    const cached = versionCache.get(key);
    if (!cached || cached.versions.length === 0) continue;
    if (candidates.some((c) => c.dep === dep)) continue;
    const currentTagPart = currentTagOf(dep);
    const hasLowerVersionInRegistry = cached.versions.some(
      (v) => isDowngrade(currentTagPart, v.version),
    );
    if (hasLowerVersionInRegistry) {
      clack.log.warn(
        `${dep.name}@${dep.current}: no downgrade candidate found — ` +
        `--mode ${mode} may have filtered out lower versions. ` +
        `Try --mode major to allow cross-semver-level downgrades.`,
      );
    }
  }
}

/**
 * Pick the target version entry from the resolved cache for this dep.
 * Returns null when the dep should be skipped entirely (no viable downgrade candidate).
 */
function selectTargetEntry(
  versions: CachedResolution["versions"],
  currentTagPart: string,
  allowDowngrade: AllowDowngrade,
  dep: DepRef,
  isJson: boolean,
): CachedResolution["versions"][number] | null {
  // versions[] is sorted newest-first by resolveEager/resolveLazy and only contains
  // age-gated entries, so versions[0] is always the newest age-safe version.
  if (allowDowngrade !== "only") return versions[0];
  const downgradeEntry = versions.find((v) => isDowngrade(currentTagPart, v.version));
  if (!downgradeEntry) {
    if (!isJson) {
      clack.log.info(
        `${dep.name}@${dep.current}: no age-gated downgrade candidate available ` +
        `(--allow-downgrade only)`,
      );
    }
    return null;
  }
  return downgradeEntry;
}

/**
 * Build the UpdateCandidate for a pin-in-place operation (mutable tag → its current digest).
 * Returns null when the pin should be skipped.
 */
function buildPinInPlaceCandidate(
  dep: DepRef,
  latestEntry: CachedResolution["versions"][number],
  currentAgeDays: number | null,
  resolvedDigest: string | null | undefined,
  allowDowngrade: AllowDowngrade,
  minAgeDays: number,
  pinUnpinned: boolean,
  isJson: boolean,
): UpdateCandidate | null {
  // Pin-in-place ops have no version delta — skip in --allow-downgrade only mode so they
  // don't mask the "nothing to downgrade" signal.
  if (allowDowngrade === "only") {
    if (!isJson) {
      core.info(
        `[lisan] ${dep.ecosystem}: skipping pin-in-place for ${dep.name} — ` +
        `pinning a mutable tag to its current digest is not a downgrade (--allow-downgrade only)`,
      );
    }
    return null;
  }
  if (!meetsMinAge(currentAgeDays, minAgeDays)) {
    // Bypass is only for originally-unpinned refs where a digest was actually resolved.
    const wasUnpinned = wasUnpinnedRef(dep);
    const canPinAnyway = shouldBypassAgeGate(wasUnpinned, pinUnpinned) && Boolean(resolvedDigest);
    if (!canPinAnyway) {
      if (!isJson) {
        core.warning(
          `[lisan] ${dep.ecosystem}: skipping pin for ${dep.name} — ${formatAgeClause(currentAgeDays, minAgeDays)}; ` +
          `leave the tag mutable until the image meets the age gate`,
        );
      }
      return null;
    }
    if (!isJson) {
      core.warning(
        `[lisan] ${dep.ecosystem}: pinning previously-unpinned ${dep.name}:${latestEntry.version} to its ` +
        `current digest despite ${formatAgeClause(currentAgeDays, minAgeDays)} (--pin-unpinned); pass --no-pin-unpinned to skip`,
      );
    }
  }
  return {
    dep,
    latest: latestEntry.version,
    pinnedTo: resolvedDigest ?? undefined,
    updateLevel: "patch",
    publishDate: latestEntry.publishDate,
    ageDays: currentAgeDays,
    breaking: false,
    direction: "upgrade",
  };
}

/**
 * Build the UpdateCandidate for a version-bump operation.
 * Returns null when the bump should be skipped (already current, age-gated downgrade, etc.).
 */
function buildVersionBumpCandidate(
  dep: DepRef,
  latestEntry: CachedResolution["versions"][number],
  currentTagPart: string,
  currentAgeDays: number | null,
  allowDowngrade: AllowDowngrade,
  minAgeDays: number,
  isJson: boolean,
): UpdateCandidate | null {
  const latest = latestEntry.version;
  // "only" mode already selected a downgrade entry in selectTargetEntry; skip the no-op guard.
  if (allowDowngrade !== "only" && latest === currentTagPart) return null;
  const { keep, direction, violatesAge } = decideDowngrade({
    current: currentTagPart, target: latest, currentAgeDays, minAgeDays, allowDowngrade,
  });
  if (!keep) {
    if (!isJson && direction === "downgrade" && violatesAge && allowDowngrade === "no") {
      clack.log.info(
        `${dep.name}@${dep.current} is ${currentAgeDays}d old (< ${minAgeDays}d min-age); not downgrading (allow-downgrade=no)`,
      );
    }
    return null;
  }
  if (!isJson && direction === "downgrade") {
    const ageClause = violatesAge && currentAgeDays !== null
      ? ` (${currentAgeDays}d old, < ${minAgeDays}d min-age)` : "";
    clack.log.warn(`${dep.name}@${dep.current}${ageClause}; downgrading to ${latest}`);
  }
  const updateLevel = classifyUpdateLevel(currentTagPart, latest);
  return {
    dep,
    latest,
    pinnedTo: undefined,
    updateLevel,
    publishDate: latestEntry.publishDate,
    ageDays: latestEntry.ageDays,
    breaking: updateLevel === "major",
    direction,
  };
}

// N1: buildCandidates and its helpers above call clack.log.*/core.* directly, gated by
// `isJson`, rather than going through an injected logger sink like dedupeAndResolve does.
// A prior attempt to unify these behind one logger interface would have silently rerouted
// the core.info/core.warning calls in buildPinInPlaceCandidate through clack — losing their
// GitHub Actions annotation semantics (::notice::/::warning::) in favor of TUI-only styling.
// Preserving the two distinct channels correctly needs a logger interface with parity for
// both, which is more machinery than this nit warrants; left as direct calls.
export function buildCandidates(
  filteredDeps: DepRef[],
  versionCache: Map<string, CachedResolution>,
  opts: RunOpts,
): UpdateCandidate[] {
  const { mode, minAgeDays, allowDowngrade, json: isJson } = opts;
  const candidates: UpdateCandidate[] = [];

  for (const dep of filteredDeps) {
    const key = resolveCacheKey(dep.ecosystem, dep.name, dep.current);
    const cached = versionCache.get(key);
    if (!cached || cached.versions.length === 0) continue;

    // dep.current for digest-pinned OCI images is "tag@sha256:..." (from makeVersion).
    // Extract just the tag portion for comparison and semver classification.
    const currentTagPart = currentTagOf(dep);
    const latestEntry = selectTargetEntry(cached.versions, currentTagPart, allowDowngrade, dep, isJson);
    if (!latestEntry) continue;

    const candidate = cached.pinInPlace
      ? buildPinInPlaceCandidate(dep, latestEntry, cached.currentAgeDays, cached.resolvedDigest, allowDowngrade, minAgeDays, opts.pinUnpinned, isJson)
      : buildVersionBumpCandidate(dep, latestEntry, currentTagPart, cached.currentAgeDays, allowDowngrade, minAgeDays, isJson);
    if (candidate !== null) candidates.push(candidate);
  }

  if (allowDowngrade === "only" && !isJson) {
    warnNoDowngradeCandidates(filteredDeps, candidates, versionCache, mode);
  }

  return candidates;
}
