import * as core from "@actions/core";
import * as clack from "@clack/prompts";
import type { RegistryUrls } from "../inputs.js";
import { ociDigestForTag } from "../registry.js";
import {
  parseImageRef,
  ociDigestOf,
  isOciEcosystem,
  wasUnpinnedRef,
  currentTagOf,
  fetchImageAgeFromDigest,
} from "../ecosystems/image.js";
import { resolveRefToSha } from "../ecosystems/actions.js";
import { writeRawStdout } from "../actions-stdout.js";
import { runBatched } from "../concurrency.js";
import { dedupeAndResolve, RESOLVE_CONCURRENCY } from "./resolve.js";
export { dedupeAndResolve, RESOLVE_CONCURRENCY } from "./resolve.js";
import { resolveLatest, ownerRepoOf, decideLicense, type CachedResolution } from "./latest.js";
import { meetsMinAge } from "../age.js";
import { fetchLicense, normalizeSpdxId } from "../license.js";
import { resolveCacheKey } from "./cache-key.js";
export { resolveCacheKey } from "./cache-key.js";
import { shouldBypassAgeGate, formatAgeClause } from "./age-gate.js";
import { ECOSYSTEM_DISPATCH, constantKeyOf, resolveDepRealpaths } from "./dispatch.js";
import { buildCandidates } from "./candidates.js";
import {
  reconcileConstantGroups,
  javaExistenceCheck,
  rustExistenceCheck,
  makeBazelExistenceCheck,
  javaAgeCheck,
  rustAgeCheck,
  makeBazelAgeCheck,
  type ExistenceCheck,
  type AgeCheck,
} from "./reconcile-groups.js";
import { buildAndApplyEdits } from "./write-pipeline.js";
import { selectCandidates } from "./select.js";
export { UserCancelledError } from "./select.js";
import type {
  AllowDowngrade,
  LicensePolicy,
  UpdateMode,
  UpdateStyle,
  DepRef,
  UpdateCandidate,
} from "./types.js";
import type { ParsedImageRef } from "../ecosystems/types.js";
export { SUPPORTED_ECOSYSTEMS } from "./ecosystems.js";

export interface RunOpts {
  ecosystems: string[];
  workflowFiles?: string;
  dockerfiles?: string;
  kubernetesFiles?: string;
  moduleBazel?: string;
  mode: UpdateMode;
  style: UpdateStyle;
  minAgeDays: number;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  exclude: RegExp[];
  allowDowngrade: AllowDowngrade;
  licensePolicy: LicensePolicy;
  token: string;
  registries: RegistryUrls;
  bcrUrl: string;
  /** Docker Hub mirror URL (e.g. mirror.gcr.io) — tried as fallback when Docker Hub rate-limits digest resolution, matching the verify path's mirror strategy. */
  dockerhubMirror?: string;
  /**
   * When true (default), pin a previously-unpinned (tag-only) docker/kubernetes image to its
   * current digest even when the image fails the age gate (too young or publish date
   * unconfirmable). A warning is always emitted in this case.
   *
   * Rationale: pinning a mutable tag to the digest it resolves to *today* introduces no new
   * content — it freezes what the user is already running. The age gate's purpose is to prevent
   * a *newer*, unvetted image from sneaking in, which is not relevant here.
   *
   * Already-pinned images whose tag moved to a too-young digest are NOT bypassed — that case
   * is the protective one and stays fail-closed regardless of this flag.
   *
   * Set to false (--no-pin-unpinned) to restore the original fail-closed behavior.
   */
  pinUnpinned: boolean;
}

export interface RunResult {
  candidates: UpdateCandidate[];
  applied: UpdateCandidate[];
  skipped: UpdateCandidate[];
  /** Candidates whose target file failed to write (build- or apply-time error). */
  failed: UpdateCandidate[];
  /**
   * Candidates that were selected but produced no file edit — e.g. the constant
   * was reconcile-dropped, the template was incompatible, or the digest was
   * unresolvable. Distinct from `failed` (no write was attempted) and from
   * `skipped` (these were positively selected by the user/--yes).
   */
  noEdits: UpdateCandidate[];
}

/**
 * When an OCI tag has moved between resolve and pin time (the freshly-fetched digest differs
 * from the pre-resolved one), re-fetch the new digest's publish date and gate it before
 * accepting it (fail-closed) — the new content might be brand-new. For a previously-unpinned
 * ref under `pinUnpinned=true`, still pins with a warning rather than nulling out (the user
 * already opted into pinning unverified images); already-pinned refs stay fail-closed.
 * Returns the digest to pin (or `null` to skip) plus the refreshed age metadata to propagate
 * to every candidate sharing this pin's cache key, or `null` when the digest was rejected.
 */
async function reGateMovedTag(
  eco: "docker" | "kubernetes",
  dep: DepRef,
  latest: string,
  ref: ParsedImageRef,
  freshDigest: string,
  minAgeDays: number,
  pinUnpinned: boolean,
): Promise<{ pin: string | null; refreshedAge: { ageDays: number | null; publishDate: Date | null } | null }> {
  const { publishDate: d, ageDays: freshAge } = await fetchImageAgeFromDigest(
    ref.registry, ref.repository, freshDigest, latest,
  );
  const ageClause = formatAgeClause(freshAge, minAgeDays);

  if (!meetsMinAge(freshAge, minAgeDays)) {
    const wasUnpinned = wasUnpinnedRef(dep);
    if (shouldBypassAgeGate(wasUnpinned, pinUnpinned)) {
      core.warning(
        `[lisan] ${eco}: ${dep.name}:${latest} tag moved upstream; ` +
        `new digest is ${ageClause} but pinning previously-unpinned image anyway ` +
        `(--pin-unpinned); pass --no-pin-unpinned to skip`,
      );
      return { pin: freshDigest, refreshedAge: { ageDays: freshAge, publishDate: d } };
    }
    core.warning(
      `[lisan] ${eco}: ${dep.name}:${latest} tag moved upstream but new ` +
      `digest is ${ageClause}; skipping pin to avoid introducing a too-young image`,
    );
    return { pin: null, refreshedAge: null };
  }
  return { pin: freshDigest, refreshedAge: { ageDays: freshAge, publishDate: d } };
}

/**
 * Resolve the SHA (actions) or OCI digest (docker/kubernetes) each pin-eligible
 * candidate should be pinned to, populating `pinCache` and assigning `pinnedTo`
 * on every matching candidate. OCI digests are always resolved; actions SHAs are
 * only resolved under "sha" style.
 */
export async function resolvePins(
  candidates: UpdateCandidate[],
  pinCache: Map<string, string | null>,
  opts: RunOpts,
): Promise<void> {
  const { style, token, minAgeDays } = opts;
  if (candidates.length === 0) return;

  // Collect unique keys and their representative candidate for resolution.
  // Use resolveCacheKey (||| separator) to avoid collisions on names containing ":" or "@"
  // (e.g. digest-pinned OCI images like "registry/repo:tag@sha256:...").
  const uniquePinKeys = new Map<string, UpdateCandidate>();
  for (const candidate of candidates) {
    const eco = candidate.dep.ecosystem;
    if (eco === "actions" && style !== "sha") continue; // actions SHA only under sha style
    if (eco !== "actions" && eco !== "docker" && eco !== "kubernetes") continue;
    const cacheKey = resolveCacheKey(eco, candidate.dep.name, candidate.latest);
    if (!uniquePinKeys.has(cacheKey)) uniquePinKeys.set(cacheKey, candidate);
  }

  // Stores age metadata refreshed when a tag moves between resolve and pin time.
  // Keyed by the same cacheKey used in pinCache so the final fan-out loop can
  // propagate it to ALL candidates sharing that key, not just the representative.
  const refreshedAgeByKey = new Map<string, { ageDays: number | null; publishDate: Date | null }>();

  const resolvePinTasks = [...uniquePinKeys.entries()].map(
    ([cacheKey, candidate]) => async () => {
      // Wrap the entire body in try/catch so that a thrown registry call (ociDigestForTag,
      // fetchImagePublishDate, resolveRefToSha) sets pinCache.set(key, null) instead of
      // leaving the key absent — an absent key lets the candidate keep its buildCandidates
      // pre-resolved digest, which contradicts the fail-closed intent.
      try {
      const eco = candidate.dep.ecosystem;
      let resolvedPin: string | null = null;

      if (eco === "actions") {
        // Use the shared cached resolver from the verify path (single code path, per-run cache).
        const ownerRepo = ownerRepoOf(candidate.dep.name); // strip subpath → "owner/repo"
        const slashIdx = ownerRepo.indexOf("/");
        const owner = ownerRepo.slice(0, slashIdx);
        const repo = ownerRepo.slice(slashIdx + 1);
        resolvedPin = await resolveRefToSha(owner, repo, candidate.latest, token);
        if (resolvedPin === null) {
          core.warning(
            `[lisan] actions: could not resolve SHA for ${candidate.dep.name}@${candidate.latest}; ` +
            `pinning as tag instead of commit SHA (sha style requested but GitHub API returned no SHA). ` +
            `This will be reflected in the summary as a tag-pinned update.`,
          );
        }
      } else if (eco === "docker" || eco === "kubernetes") {
        const ref = parseImageRef(candidate.dep.name);
        if (ref) {
          const preResolved = candidate.pinnedTo;  // set by buildCandidates from resolveLatest
          if (preResolved) {
            // Reuse the digest already resolved in resolveLatest (single round-trip, no TOCTOU).
            // If the tag moved between resolve and pin (digest changed), re-fetch the new
            // digest's publish date and gate it — the new content might be brand-new.
            const freshDigest = await ociDigestForTag(ref.registry, ref.repository, candidate.latest, opts.dockerhubMirror);
            if (freshDigest && freshDigest !== preResolved) {
              // Shared helper: fetchImagePublishDate → computeAgeDays (single code path
              // with the verify-side age computation via ecosystems/image.ts).
              const { pin, refreshedAge } = await reGateMovedTag(
                eco, candidate.dep, candidate.latest, ref, freshDigest, minAgeDays, opts.pinUnpinned,
              );
              resolvedPin = pin;
              // Propagate the fresh digest's age to both the representative candidate and the
              // shared map so ALL candidates sharing this cacheKey stay in sync below (duplicate
              // images referenced in multiple files keep stale age without this).
              if (refreshedAge !== null) {
                candidate.ageDays = refreshedAge.ageDays;
                candidate.publishDate = refreshedAge.publishDate;
                refreshedAgeByKey.set(cacheKey, refreshedAge);
              }
            } else {
              // tag hasn't moved (freshDigest === preResolved) or the re-check failed (freshDigest null).
              // A failed re-check must not silently reuse the pre-resolved digest — treat as unresolved,
              // matching the fail-closed posture of the sibling branch above.
              resolvedPin = freshDigest === preResolved ? freshDigest : null;
            }
          } else {
            resolvedPin = await ociDigestForTag(ref.registry, ref.repository, candidate.latest, opts.dockerhubMirror);
          }
        }
        if (resolvedPin === null) {
          core.warning(
            `[lisan] ${eco}: could not resolve digest for ${candidate.dep.name}:${candidate.latest}; ` +
            `skipping — not writing a mutable ref without a digest`,
          );
        }
      }

      pinCache.set(cacheKey, resolvedPin);
      } catch (err) {
        // Fail-closed: a thrown registry call must not leave the key absent (absent → candidate
        // keeps its buildCandidates pre-resolved digest instead of being skipped). Set null so
        // the candidate is filtered out in the pinCache.has() fan-out loop below.
        core.warning(
          `[lisan] ${candidate.dep.ecosystem}: pin resolution threw for ${candidate.dep.name}; ` +
          `failing closed — ${err instanceof Error ? err.message : String(err)}`,
        );
        pinCache.set(cacheKey, null);
      }
    },
  );

  await runBatched(resolvePinTasks, RESOLVE_CONCURRENCY, (m) => core.warning(m));

  // Apply resolved pins to all matching candidates.
  // Using pinCache.has() rather than a truthiness check so that null (meaning
  // "resolution ran and decided to skip this pin — e.g. moved tag too young")
  // is honoured instead of silently falling back to the pre-resolved digest
  // that buildCandidates() set earlier. Without this, a null resolvedPin would
  // be a no-op and the candidate would survive the `!c.pinnedTo` filter with a
  // stale digest, contradicting the explicit "skip" decision.
  //
  // Also propagate refreshed age metadata to ALL candidates sharing a cacheKey,
  // not just the representative candidate updated in resolvePinTasks above.
  // Duplicate candidates (same image referenced in multiple files) would otherwise
  // keep stale ageDays/publishDate from buildCandidates() in --json / hints.
  for (const candidate of candidates) {
    const eco = candidate.dep.ecosystem;
    if (eco !== "actions" && eco !== "docker" && eco !== "kubernetes") continue;
    const cacheKey = resolveCacheKey(eco, candidate.dep.name, candidate.latest);
    if (pinCache.has(cacheKey)) {
      const pin = pinCache.get(cacheKey);
      candidate.pinnedTo = pin ?? undefined;
    }
    const refreshedAge = refreshedAgeByKey.get(cacheKey);
    if (refreshedAge) {
      candidate.ageDays = refreshedAge.ageDays;
      candidate.publishDate = refreshedAge.publishDate;
    }
  }
}

/**
 * Fetch current/new licenses for each version-bumping candidate and apply the
 * license policy, annotating each candidate's licenseCurrent/licenseNew/
 * licenseRegresses/licenseBlocked fields in place. `licenseMap` is populated with
 * the fetched raw license strings (keyed eco|||name|||version).
 */
export async function applyLicensePolicy(
  candidates: UpdateCandidate[],
  licenseMap: Map<string, string | null>,
  opts: RunOpts,
): Promise<void> {
  const { licensePolicy, registries, token, bcrUrl, json: isJson } = opts;
  if (licensePolicy === "off") return;

  const javaRepoMap = new Map<string, string[]>();
  for (const c of candidates) {
    if (c.dep.ecosystem === "java" && c.dep.repositories) {
      javaRepoMap.set(c.dep.name, c.dep.repositories);
    }
  }

  // Candidates eligible for license checking (version-bumping ecosystems only).
  const licenseEligible = candidates.filter((c) => !isOciEcosystem(c.dep.ecosystem));

  // Deduplicate fetches using resolveCacheKey (||| separator, safe for all name/version forms).
  // currentTagOf strips the @sha256: suffix for OCI ecosystems — only strip for those.
  const uniqueFetches = new Map<string, { ecosystem: string; name: string; version: string }>();
  for (const c of licenseEligible) {
    const curVer = currentTagOf(c.dep);
    const curKey = resolveCacheKey(c.dep.ecosystem, c.dep.name, curVer);
    const newKey = resolveCacheKey(c.dep.ecosystem, c.dep.name, c.latest);
    if (!uniqueFetches.has(curKey))
      uniqueFetches.set(curKey, { ecosystem: c.dep.ecosystem, name: c.dep.name, version: curVer });
    if (!uniqueFetches.has(newKey))
      uniqueFetches.set(newKey, { ecosystem: c.dep.ecosystem, name: c.dep.name, version: c.latest });
  }

  // Track which cache keys had a registry fetch error — distinct from `null` (no license declared).
  // Used to fail-closed under `block` policy when the new version's license cannot be confirmed.
  const licenseFetchErrors = new Set<string>();

  const licenseFetchTasks = [...uniqueFetches.entries()].map(([key, spec]) => async () => {
    try {
      const raw = await fetchLicense(spec, registries, javaRepoMap, token, bcrUrl);
      licenseMap.set(key, raw);
    } catch (err) {
      // Log the error so the operator knows which fetch failed and why, rather than silently
      // treating a transient 5xx/timeout as "no license declared".
      core.warning(
        `[lisan] license: fetch failed for ${spec.ecosystem}:${spec.name}@${spec.version} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      licenseFetchErrors.add(key);
      licenseMap.set(key, null);
    }
  });

  const spin = isJson ? null : clack.spinner();
  spin?.start("Checking license permissiveness…");
  await runBatched(licenseFetchTasks, RESOLVE_CONCURRENCY, (m) => core.warning(m));
  spin?.stop("Done.");

  for (const c of licenseEligible) {
    const curVer = currentTagOf(c.dep);
    c.licenseCurrent = normalizeSpdxId(licenseMap.get(resolveCacheKey(c.dep.ecosystem, c.dep.name, curVer)) ?? null);
    c.licenseNew = normalizeSpdxId(licenseMap.get(resolveCacheKey(c.dep.ecosystem, c.dep.name, c.latest)) ?? null);
    const newKey = resolveCacheKey(c.dep.ecosystem, c.dep.name, c.latest);
    const { keep, regresses, verified } = decideLicense({
      currentLicense: c.licenseCurrent,
      newLicense: c.licenseNew,
      policy: licensePolicy,
      newLicenseFetchFailed: licenseFetchErrors.has(newKey),
    });
    c.licenseRegresses = verified ? regresses : undefined;
    c.licenseBlocked = !keep;
    if (!isJson) {
      if (!keep) {
        const reason = licenseFetchErrors.has(newKey)
          ? `new license could not be confirmed (registry fetch error); skipping (--license-policy=block)`
          : `license tightens ${c.licenseCurrent} → ${c.licenseNew}; skipping (--license-policy=block)`;
        clack.log.warn(`${c.dep.name}: ${reason}`);
      } else if (regresses && verified) {
        clack.log.warn(
          `${c.dep.name}: license tightens ${c.licenseCurrent} → ${c.licenseNew} (--license-policy=warn)`,
        );
      }
    }
  }
  // Blocked candidates remain in the list for JSON/RunResult visibility;
  // they are excluded from selection in Step 8.
}

/**
 * Discover all dependency refs across the requested ecosystems.
 * Per-ecosystem discover() failures are logged as warnings and do not abort
 * discovery for other ecosystems — mirrors the verify action's resilience in main.ts.
 *
 * Throws when every requested ecosystem both (a) has a registered dispatch and
 * (b) threw during discover(), because that state is indistinguishable from a
 * clean repo (allDeps is empty, run() would report "no updates") but is actually
 * a misconfiguration (bad --module-bazel path, missing workflow dir, etc.).  A
 * partial failure (some ecosystems succeed, some fail) is still just a warning.
 */
async function discoverDeps(opts: RunOpts): Promise<DepRef[]> {
  const { ecosystems } = opts;
  const allDeps: DepRef[] = [];
  let dispatchedCount = 0;
  let errorCount = 0;

  for (const eco of ecosystems) {
    const dispatch = ECOSYSTEM_DISPATCH[eco];
    if (!dispatch) {
      core.warning(`[lisan] unknown ecosystem: ${eco}`);
      continue;
    }
    dispatchedCount++;
    try {
      const discovered = await dispatch.discover(opts);
      allDeps.push(...discovered);
    } catch (err) {
      errorCount++;
      core.warning(
        `[lisan] discover failed for ecosystem ${eco}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (dispatchedCount > 0 && errorCount === dispatchedCount) {
    throw new Error(
      `[lisan] all ${dispatchedCount} requested ecosystem(s) failed during discovery ` +
      `(check --module-bazel path and other file inputs). ` +
      `This is a configuration error, not an empty repo.`,
    );
  }

  return allDeps;
}

/**
 * Split OCI pin-in-place candidates into those with resolved digests and those that
 * failed digest resolution. Non-OCI candidates pass through unchanged.
 */
function filterResolvedDigests(candidates: UpdateCandidate[]): {
  resolved: UpdateCandidate[];
  digestDropped: UpdateCandidate[];
} {
  const digestDropped: UpdateCandidate[] = [];
  const resolved = candidates.filter((c) => {
    if (c.dep.ecosystem !== "docker" && c.dep.ecosystem !== "kubernetes") return true;
    if (!c.pinnedTo) {
      digestDropped.push(c);
      core.warning(`[lisan] ${c.dep.name}: could not resolve OCI digest — skipping`);
      return false;
    }
    const existingDigest = ociDigestOf(c.dep.current) ?? undefined;
    return existingDigest !== c.pinnedTo;
  });
  return { resolved, digestDropped };
}

/**
 * Route digest-unresolvable OCI candidates to `skipped` or `failed` depending on whether
 * this is a report-only invocation (`--json`, `--dry-run`) or a real apply run. Report-only
 * modes never write files, so an unresolvable digest is advisory (skipped); a real apply run
 * couldn't write that candidate, so it's a genuine failure. Centralizes the rule that was
 * previously re-derived at each of the three `run()` return points.
 */
function routeDigestDropped(
  digestDropped: UpdateCandidate[],
  isReportOnly: boolean,
): { skippedExtra: UpdateCandidate[]; failedExtra: UpdateCandidate[] } {
  return isReportOnly
    ? { skippedExtra: digestDropped, failedExtra: [] }
    : { skippedExtra: [], failedExtra: digestDropped };
}

/**
 * Build the final RunResult so both the --json early-return and the normal apply-run return
 * point share one shape. `digestDropped` candidates are folded back into `candidates` here —
 * `resolvedCandidates` (computed by filterResolvedDigests) excludes them, so without this a
 * candidate that ends up in `failed`/`skipped` via routeDigestDropped would be invisible to a
 * consumer rendering `result.candidates`, despite a non-zero exit code on a real apply run.
 */
function assembleResult(opts: {
  resolvedCandidates: UpdateCandidate[];
  digestDropped: UpdateCandidate[];
  applied: UpdateCandidate[];
  skipped: UpdateCandidate[];
  failed: UpdateCandidate[];
  noEdits: UpdateCandidate[];
}): RunResult {
  return {
    candidates: [...opts.resolvedCandidates, ...opts.digestDropped],
    applied: opts.applied,
    skipped: opts.skipped,
    failed: opts.failed,
    noEdits: opts.noEdits,
  };
}

/**
 * Collapse the duplicated JSON-early-return vs. apply-path final-return finalization logic
 * (routeDigestDropped + assembleResult) into one call. `isReportOnly` selects whether
 * digest-unresolvable candidates are advisory (skipped, for --json/--dry-run) or genuine
 * failures (a real apply run that couldn't write them). `skippedBase`/`failedBase` are the
 * base arrays each call site folds `skippedExtra`/`failedExtra` into — they differ between
 * the two call sites (see run()) but the merge order and shape are otherwise identical.
 */
function finalize(opts: {
  resolvedCandidates: UpdateCandidate[];
  digestDropped: UpdateCandidate[];
  isReportOnly: boolean;
  applied: UpdateCandidate[];
  skippedBase: UpdateCandidate[];
  failedBase: UpdateCandidate[];
  noEdits: UpdateCandidate[];
}): RunResult {
  const { skippedExtra, failedExtra } = routeDigestDropped(opts.digestDropped, opts.isReportOnly);
  return assembleResult({
    resolvedCandidates: opts.resolvedCandidates,
    digestDropped: opts.digestDropped,
    applied: opts.applied,
    skipped: [...opts.skippedBase, ...skippedExtra],
    // failedExtra MUST come first — matches the original ordering exactly at both call sites.
    failed: [...failedExtra, ...opts.failedBase],
    noEdits: opts.noEdits,
  });
}

/**
 * Identify shared-constant literal keys where any member candidate is license-blocked.
 * The literal cannot be bumped without also bumping the blocked dep.
 */
function computeBlockedConstantKeys(
  candidates: UpdateCandidate[],
  depRealpaths: Map<string, string>,
): Set<string> {
  const blockedConstantKeys = new Set<string>();
  for (const c of candidates) {
    if (c.licenseBlocked) {
      const key = constantKeyOf(c.dep, depRealpaths);
      if (key !== null) blockedConstantKeys.add(key);
    }
  }
  return blockedConstantKeys;
}

/** Serialize candidates to the --json output shape. */
function buildJsonOutput(
  candidates: UpdateCandidate[],
  depRealpaths: Map<string, string>,
  blockedConstantKeys: Set<string>,
) {
  return candidates.map((c) => {
    const key = constantKeyOf(c.dep, depRealpaths);
    const excludedByBlockedGroup = !c.licenseBlocked && key !== null && blockedConstantKeys.has(key);
    return {
      ecosystem: c.dep.ecosystem,
      name: c.dep.name,
      file: c.dep.file,
      current: c.dep.current,
      latest: c.latest,
      pinnedTo: c.pinnedTo,
      updateLevel: c.updateLevel,
      breaking: c.breaking,
      ageDays: c.ageDays,
      direction: c.direction,
      licenseCurrent: c.licenseCurrent,
      licenseNew: c.licenseNew,
      licenseRegresses: c.licenseRegresses,
      licenseBlocked: c.licenseBlocked,
      excludedByBlockedGroup,
    };
  });
}

export async function run(opts: RunOpts): Promise<RunResult> {
  const {
    mode,
    style,
    minAgeDays,
    yes,
    dryRun,
    json: isJson,
    exclude,
    token,
    registries,
    bcrUrl,
  } = opts;

  // Step 1 — Discover deps across all ecosystems (errors per-ecosystem, not whole-run).
  const allDeps = await discoverDeps(opts);

  // Step 2 — Filter exclusions
  const filteredDeps = exclude.length > 0
    ? allDeps.filter((dep) => !exclude.some((re) => re.test(dep.name)))
    : allDeps;

  // Warn when every discovered dep was excluded — this is almost always a mistake
  // (e.g. --exclude '.*' or an empty pattern that matches everything).
  if (exclude.length > 0 && allDeps.length > 0 && filteredDeps.length === 0) {
    core.warning(
      `[lisan] all ${allDeps.length} discovered dep(s) were excluded by --exclude patterns — nothing to update`,
    );
  }

  // Steps 3–4 — Deduplicate by cache key then resolve latest for each unique dep.
  // We keep the real DepRef (not a re-serialised one) so names containing "@"
  // (digest-pinned OCI images like "tag@sha256:...") round-trip correctly.
  // dedupeAndResolve uses runBatched (Promise.allSettled) — per-task rejections
  // (including mavenMetadataVersions "all repos unreachable" throws) are logged
  // as warnings and do NOT abort the batch; the dep is absent from versionCache
  // and skipped during candidate building.
  const spin = isJson ? null : clack.spinner();
  spin?.start("Resolving latest versions…");

  const rawVersionCache = await dedupeAndResolve(
    filteredDeps,
    (dep) => resolveCacheKey(dep.ecosystem, dep.name, dep.current),
    (dep) => resolveLatest(dep, {
      mode,
      minAgeDays,
      token,
      registries,
      bcrUrl,
      javaRepositories: dep.repositories,
      dockerhubMirror: opts.dockerhubMirror,
      allowDowngrade: opts.allowDowngrade,
    }),
    RESOLVE_CONCURRENCY,
  );

  // Strip null entries (resolution errors) — null means resolveLatest threw and the
  // dep should be absent from versionCache (same as before dedupeAndResolve).
  const versionCache = new Map<string, CachedResolution>();
  for (const [key, value] of rawVersionCache) {
    if (value !== null) versionCache.set(key, value);
  }

  spin?.stop("Done.");

  // Step 5 — Build UpdateCandidate list
  const candidates = buildCandidates(filteredDeps, versionCache, opts);

  // Step 6 — Resolve SHA/digest for pin-eligible candidates.
  // OCI digest (docker/k8s) is always resolved regardless of style — buildFileEdits
  // requires a digest to produce any output, so skipping resolution under "preserve"
  // would silently produce zero edits. Actions SHA is only resolved under "sha" style.
  await resolvePins(candidates, new Map<string, string | null>(), opts);

  // Step 7 — Shared-constant cross-artifact validation (java/rust/bazel, pre-confirmation).
  // A single pass groups across ALL Starlark ecosystems so constants shared between e.g.
  // maven.install and bazel_dep are validated for every referencing dep.
  await reconcileConstantGroups(
    candidates,
    filteredDeps,
    new Map<string, ExistenceCheck>([
      ["java", javaExistenceCheck],
      ["rust", rustExistenceCheck],
      ["bazel", makeBazelExistenceCheck(token, bcrUrl)],
    ]),
    new Map<string, AgeCheck>([
      ["java", javaAgeCheck],
      ["rust", rustAgeCheck],
      ["bazel", makeBazelAgeCheck(token, bcrUrl)],
    ]),
    registries,
    minAgeDays,
    versionCache,
  );

  // Filter OCI (docker/kubernetes) pin-in-place candidates:
  // - Drop if no digest could be resolved (would emit nothing and confuse the UI).
  //   Candidates dropped for this reason are accumulated into digestDropped and
  //   threaded into the RunResult's `failed` bucket — the user selected these
  //   candidates (or --yes did) and a silent drop would mask the failure.
  // - Drop if the resolved digest is identical to the one already in dep.current
  //   (the mutable tag didn't move upstream → genuine no-op, nothing to write).
  const { resolved: resolvedCandidates, digestDropped } = filterResolvedDigests(candidates);

  // Step 8 — License permissiveness check (docker/kubernetes excluded: digest pins, no version delta)
  await applyLicensePolicy(resolvedCandidates, new Map<string, string | null>(), opts);

  // Pre-compute shared-constant group exclusions BEFORE the JSON early-return so that
  // --json output includes `excludedByBlockedGroup` and accurately reflects what the apply
  // path does. A CI consumer parsing --json to decide what to apply would otherwise see a
  // candidate with licenseBlocked:false that the apply path would silently refuse (because
  // its shared-constant sibling is blocked and they share the same literal byte range).
  //
  // Pre-resolve realpaths for all Starlark dep files so constantKeyOf and buildSelectionGroups
  // agree with reconcileConstantGroups — collapsing symlink aliases to the same physical
  // MODULE.bazel into one key rather than two.
  const depRealpaths = await resolveDepRealpaths(resolvedCandidates.map((c) => c.dep));
  const blockedConstantKeys = computeBlockedConstantKeys(resolvedCandidates, depRealpaths);

  // Step 9 — JSON output
  if (isJson) {
    const output = buildJsonOutput(resolvedCandidates, depRealpaths, blockedConstantKeys);
    // Bypass installActionsCommandFilter (installed by update/cli.ts) so this payload
    // always reaches the real stdout, even though @actions/core warnings fired earlier
    // in this same run are being redirected to stderr by that same filter.
    writeRawStdout(JSON.stringify(output, null, 2) + "\n");
    // Nothing is written in JSON mode, so `applied` is empty — digestDropped candidates are
    // routed via routeDigestDropped (report-only → skipped) so that `--json` exits 0 even when
    // some digests couldn't be resolved. Unresolvable digests are surfaced in the printed JSON
    // via `pinnedTo: null` entries in the output array, so consumers can still identify them
    // without relying on a non-zero exit code.
    return finalize({
      resolvedCandidates,
      digestDropped,
      isReportOnly: true,
      applied: [],
      skippedBase: resolvedCandidates,
      failedBase: [],
      noEdits: [],
    });
  }

  // Step 10 — Selection
  // depRealpaths and blockedConstantKeys already computed before the JSON block above.
  const applyableCandidates = resolvedCandidates.filter((c) => {
    if (c.licenseBlocked) return false;
    const key = constantKeyOf(c.dep, depRealpaths);
    return key === null || !blockedConstantKeys.has(key);
  });
  const selected = (yes || dryRun)
    ? applyableCandidates
    : await selectCandidates(applyableCandidates, depRealpaths);

  // Step 11 — Build edits and apply them to disk.
  const { actuallyApplied, failed, noEdits } = await buildAndApplyEdits(selected, style, dryRun);

  if (failed.length > 0) {
    core.warning(
      `[lisan] ${failed.length} update(s) could not be written: ` +
      failed.map((c) => `${c.dep.name} (${c.dep.file})`).join(", "),
    );
  }

  // In dry-run mode, `actuallyApplied` is empty (nothing written). Report the candidates
  // that WOULD have been applied: selected minus benign-skip noEdits and build failures.
  // This makes the dry-run preview truthful — it no longer overstates by including
  // candidates that would silently produce no file edits in a real run.
  const applied = dryRun
    ? selected.filter((c) => !noEdits.includes(c) && !failed.includes(c))
    : actuallyApplied;

  // In dry-run mode, unresolvable-digest candidates are advisory (skipped), not failures,
  // mirroring the --json early-return. Only a real apply run can meaningfully fail them.
  return finalize({
    resolvedCandidates,
    digestDropped,
    isReportOnly: dryRun,
    applied,
    skippedBase: resolvedCandidates.filter((c) => !selected.includes(c)),
    failedBase: failed,
    noEdits,
  });
}
