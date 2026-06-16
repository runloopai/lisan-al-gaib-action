import * as core from "@actions/core";
import type { RegistryUrls } from "../inputs.js";
import { mavenArtifactExists, mavenPublishDate, cratesVersions, bcrVersions, bcrPublishDate } from "../registry.js";
import { runBatched } from "../concurrency.js";
import { RESOLVE_CONCURRENCY } from "./resolve.js";
import { isPrerelease, type CachedResolution } from "./latest.js";
import { meetsMinAge, computeAgeDays } from "../age.js";
import { pickSemverMin, allVersionsComparable } from "./ecosystems/bazel-shared.js";
import { resolveCacheKey } from "./cache-key.js";
import { formatAgeClause } from "./age-gate.js";
import { STARLARK_ECOSYSTEMS, versionRefOf, constantKeyOf, resolveDepRealpaths } from "./dispatch.js";
import type { DepRef, UpdateCandidate } from "./types.js";

/** Existence check signature: does `version` of `name` exist in `repos`/`registries`? */
export type ExistenceCheck = (
  name: string,
  version: string,
  repos: string[],
  registries: RegistryUrls,
) => Promise<boolean>;

/**
 * Age check signature: how many days old is `version` of `name`, per `repos`/`registries`?
 * Returns null when the publish date cannot be confirmed — callers must treat that as
 * fail-closed (not age-gated) via {@link meetsMinAge}, exactly like the primary resolve path.
 */
export type AgeCheck = (
  name: string,
  version: string,
  repos: string[],
  registries: RegistryUrls,
) => Promise<number | null>;

/**
 * Pure (non-async, no registry calls) guards on a constant group that decide whether it's
 * even safe to attempt picking a semver-minimum target version: divergent interpolation
 * templates, an unvalidatable read-only rpartition sibling, non-coercible candidate
 * versions, or every candidate being a prerelease. Returns the candidate to propose as the
 * group's target version (semver-minimum of stable candidates) on success, or the warning
 * message to emit when the group must be dropped before ever reaching the async
 * existence/age check below. Caller must ensure `groupCandidates.length > 0`.
 */
function groupDropReason(
  group: { deps: DepRef[]; constantName?: string; hasReadOnlySiblings: boolean },
  groupCandidates: UpdateCandidate[],
  key: string,
): { reason: string } | { minCandidate: UpdateCandidate } {
  const constLabel = group.constantName ?? key;

  // Guard: if the deps sharing this constant use different templatePrefix/templateSuffix, the
  // "reconcile in two value-spaces" bug is triggered — resolveLatest returns different full
  // versions (prefix+value+suffix) per dep, so the semver-min of full versions is in a
  // different space from the semver-min of stripped constant values. The written constant
  // value may yield an effective version for some dep that was never existence-checked.
  // Fail-safe: if templates diverge, drop the group rather than silently pick a wrong value.
  const templates = new Set(
    group.deps.map((d) => {
      const vr = versionRefOf(d);
      return `${vr?.templatePrefix ?? ""}::${vr?.templateSuffix ?? ""}`;
    }),
  );
  if (templates.size > 1) {
    return {
      reason: `Shared constant "${constLabel}": deps use different interpolation templates ` +
        `(${[...templates].join(", ")}); cannot safely pick one constant value for all referencing deps — dropping group.`,
    };
  }

  // M1: Guard against rpartition-derived read-only sibling refs.  If the constant is shared
  // with a dep whose effective version is derived via CONST.rpartition(SEP)[N], bumping the
  // constant produces a new derived value (e.g. "2.20" from "2.20.7") that was never
  // existence-checked.  We cannot safely validate the derived value without knowing the
  // separator and downstream package name, so drop the group rather than risk writing a
  // version that doesn't exist or is too young.
  if (group.hasReadOnlySiblings) {
    return {
      reason: `Shared constant "${constLabel}" is referenced by a read-only rpartition sibling dep ` +
        `whose derived version cannot be validated — dropping group to avoid writing an unchecked version.`,
    };
  }

  // Proposed target: semver-minimum of all candidates (matches reconcileConstantRewrites).
  // Use semver.coerce so 2-segment versions ("4.13", "2.21") compare correctly —
  // semver.valid rejects them and would fall through to the arbitrary [0].latest fallback.
  // When coerce returns null for all candidates (no comparable version), drop the group
  // rather than blindly writing groupCandidates[0].latest which may not exist elsewhere.
  // Use pickSemverMin (same impl as reconcileConstantRewrites) so the "highest
  // version safe for all referencing deps" selection is a single code path.

  // M2: Precondition — every candidate's latest must be coercible to semver before calling
  // pickSemverMin.  pickSemverMin silently skips non-coercible entries and returns the min
  // of the rest, so if one candidate's latest is non-semver the returned minimum may exceed
  // what that dep accepts.  Uses the shared allVersionsComparable predicate from bazel-shared.ts
  // so this check and resolveConflictingReplaces's check are the same code path.
  if (!allVersionsComparable(groupCandidates.map((c) => c.latest))) {
    return {
      reason: `Shared constant "${constLabel}": some candidates have non-coercible versions ` +
        `(${groupCandidates.map((c) => c.latest).join(", ")}); cannot safely pick a semver minimum — dropping group.`,
    };
  }

  // Filter out prerelease candidates before picking the semver minimum —
  // a prerelease minimum would break stable-dep consumers that don't accept pre-releases.
  // If EVERY candidate sharing the constant is a prerelease, there is no safe stable
  // value to pick — drop the group entirely rather than falling back to the prerelease
  // set, which would write the exact prerelease minimum this filter exists to prevent.
  const stableGroupCandidates = groupCandidates.filter((c) => !isPrerelease(c.latest));
  if (stableGroupCandidates.length === 0) {
    return {
      reason: `Shared constant "${constLabel}": all candidates are prerelease versions ` +
        `(${groupCandidates.map((c) => c.latest).join(", ")}); cannot safely pick a stable minimum — dropping group.`,
    };
  }
  const minCandidate = pickSemverMin(stableGroupCandidates, (c) => c.latest);
  if (minCandidate === null) {
    // No comparable version — can't safely pick a minimum.
    return {
      reason: `Shared constant "${constLabel}": all candidates have non-semver versions ` +
        `(${groupCandidates.map((c) => c.latest).join(", ")}); dropping group.`,
    };
  }
  return { minCandidate };
}

/**
 * Confirm a single dep exists — and meets the age gate — at `proposedVersion`, using the
 * existence/age checks appropriate for its ecosystem. Returns null when the dep is validated
 * (or a cache hit already proves it), or the reason string to record as unresolvable.
 *
 * A cache hit against this dep's own resolveLatest cache is a sound substitute for a fresh
 * existence+age round-trip (that entry only exists because resolveEager/resolveLazy already
 * confirmed it exists AND passed meetsMinAge against this same minAgeDays) — a cache miss
 * still falls through to the live check, never the inverse.
 *
 * A transient registry error must fail-closed (treat the version as non-existent/too-young)
 * rather than propagating out and aborting the entire reconcile pass.
 */
async function validateDepAtVersion(
  dep: DepRef,
  proposedVersion: string,
  existenceChecks: Map<string, ExistenceCheck>,
  ageChecks: Map<string, AgeCheck>,
  registries: RegistryUrls,
  minAgeDays: number,
  versionCache?: Map<string, CachedResolution>,
): Promise<string | null> {
  const cacheKey = resolveCacheKey(dep.ecosystem, dep.name, dep.current);
  const cachedVersions = versionCache?.get(cacheKey)?.versions;
  if (cachedVersions?.some((v) => v.version === proposedVersion)) return null;

  const check = existenceChecks.get(dep.ecosystem);
  if (!check) {
    // No existence check registered for this ecosystem — fail-closed: treat as non-existent
    // rather than silently approving the dep. In practice STARLARK_ECOSYSTEMS and
    // existenceChecks are kept in sync; this guard fires only if they drift.
    return dep.name;
  }
  // The maven repos fallback only applies to java — rust/bazel existence checks
  // ignore the repos parameter entirely.
  const repos = dep.ecosystem === "java"
    ? (dep.repositories?.length ? dep.repositories : [registries.maven])
    : (dep.repositories ?? []);
  try {
    const exists = await check(dep.name, proposedVersion, repos, registries);
    if (!exists) return dep.name;
    // Existence alone is not enough: the same version string can have a different
    // publish date per registry (e.g. a maven.install artifact and a crate.spec
    // sharing one constant), so re-vet this non-winning dep against the age gate
    // it would otherwise hit when verify later re-checks it — without this, the
    // shared-constant feature could silently promote a too-young version for it.
    const ageCheck = ageChecks.get(dep.ecosystem);
    if (!ageCheck) {
      // No age check registered for this ecosystem — fail-closed, same rationale
      // as the missing-existence-check case above.
      return dep.name;
    }
    const ageDays = await ageCheck(dep.name, proposedVersion, repos, registries);
    if (!meetsMinAge(ageDays, minAgeDays)) {
      return `${dep.name} (${formatAgeClause(ageDays, minAgeDays)})`;
    }
    return null;
  } catch (err) {
    core.warning(
      `[lisan] reconcileConstantGroups: existence/age check failed for ` +
      `${dep.ecosystem}:${dep.name}@${proposedVersion}: ` +
      `${err instanceof Error ? err.message : String(err)} — treating as non-existent`,
    );
    return dep.name;
  }
}

/**
 * A Starlark constant (e.g. JACKSON_VERSION in MODULE.bazel) may be referenced by
 * multiple artifact/crate/module coords — potentially across ecosystems (e.g. a constant
 * shared by a maven.install artifact and a bazel_dep). All referencing deps must be able
 * to take the proposed target version before the upgrade is presented to the user.
 *
 * Groups by constant identity (file + literal offsets) across ALL Starlark ecosystems in
 * a single pass. Each missing dep is validated with the existence check appropriate for
 * its own ecosystem, so cross-ecosystem constants are correctly guarded.
 *
 * Mutates `candidates` in place — drops entries whose constant group is unresolvable.
 */
export async function reconcileConstantGroups(
  candidates: UpdateCandidate[],
  filteredDeps: DepRef[],
  existenceChecks: Map<string, ExistenceCheck>,
  ageChecks: Map<string, AgeCheck>,
  registries: RegistryUrls,
  minAgeDays: number,
  versionCache?: Map<string, CachedResolution>,
): Promise<void> {
  const starlarkDeps = filteredDeps.filter((d) => STARLARK_ECOSYSTEMS.has(d.ecosystem));
  if (starlarkDeps.length === 0) return;

  // Pre-resolve realpaths for all Starlark dep files so constantKeyOf agrees with
  // Pass 9b's realpath-based edit merge. Without this, the same physical MODULE.bazel
  // reachable via two different relative paths (e.g. via resolveModuleFiles includes)
  // would produce different keys and bypass cross-ecosystem existence validation.
  const fileRealpaths = await resolveDepRealpaths(starlarkDeps);

  // Group all versionRef deps by constant identity (file + offsets of the literal)
  // across all Starlark ecosystems so cross-ecosystem shared constants are caught.
  const constantGroups = new Map<string, { deps: DepRef[]; constantName?: string; hasReadOnlySiblings: boolean }>();
  for (const dep of starlarkDeps) {
    const key = constantKeyOf(dep, fileRealpaths);
    if (!key) continue;
    const vr = versionRefOf(dep)!;
    let group = constantGroups.get(key);
    if (!group) {
      group = { deps: [], constantName: vr.constantName, hasReadOnlySiblings: false };
      constantGroups.set(key, group);
    }
    if (vr.readOnly) {
      // This dep is a read-only rpartition sibling — it derives its effective version from
      // the shared constant via a lossy transform (e.g. CONST.rpartition(".")[0]).  We cannot
      // validate the derived value without knowing the separator and the downstream package
      // name, so mark the whole group unsafe to bump.
      group.hasReadOnlySiblings = true;
    }
    group.deps.push(dep);
  }

  const droppedKeys = new Set<string>();

  for (const [key, group] of constantGroups) {
    const groupCandidates = candidates.filter((c) => {
      if (!STARLARK_ECOSYSTEMS.has(c.dep.ecosystem)) return false;
      return constantKeyOf(c.dep, fileRealpaths) === key;
    });

    if (groupCandidates.length === 0) continue;

    const dropCheck = groupDropReason(group, groupCandidates, key);
    if ("reason" in dropCheck) {
      core.warning(`[lisan] ${dropCheck.reason}`);
      droppedKeys.add(key);
      continue;
    }
    const proposedVersion = dropCheck.minCandidate.latest;

    // Find referencing deps that produced no candidate — they weren't validated by resolveLatest.
    // Key on the full DepRef identity (ecosystem + name + file) to avoid false matches when
    // two different ecosystems happen to share a dep name (e.g. "com.example:foo" in both
    // java and rust contexts — unlikely but theoretically possible with custom ecosystems).
    const depIdentityKey = (d: DepRef) => `${d.ecosystem}|||${d.name}|||${d.file}`;
    const depsWithCandidate = new Set(groupCandidates.map((c) => depIdentityKey(c.dep)));
    const missingDeps = group.deps.filter((d) => !depsWithCandidate.has(depIdentityKey(d)));

    // Also validate candidates whose own `latest` differs from `proposedVersion` (the
    // semver-minimum) — a cross-ecosystem scenario where rust and java both have candidates
    // but resolved to different versions means the minimum may not exist in one registry.
    const candidatesWithDifferentLatest = groupCandidates.filter(
      (c) => c.latest !== proposedVersion,
    );

    const depsToValidate = [
      ...missingDeps,
      ...candidatesWithDifferentLatest.map((c) => c.dep),
    ];

    if (depsToValidate.length === 0) continue;

    // Confirm the proposed version actually exists — AND meets the age gate — for each
    // dep that wasn't validated at proposedVersion, using the checks appropriate for that
    // dep's ecosystem. Run checks concurrently — JS is single-threaded so concurrent pushes
    // to `unresolvable` are safe; order of results is irrelevant here.
    const unresolvable: string[] = [];
    await runBatched(
      depsToValidate.map((dep) => async () => {
        const reason = await validateDepAtVersion(
          dep, proposedVersion, existenceChecks, ageChecks, registries, minAgeDays, versionCache,
        );
        if (reason !== null) unresolvable.push(reason);
      }),
      RESOLVE_CONCURRENCY,
    );

    if (unresolvable.length > 0) {
      const constLabel = group.constantName ?? key;
      const listing = groupCandidates.map((c) => `${c.dep.name}: ${c.dep.current} → ${proposedVersion}`).join(", ");
      core.warning(
        `[lisan] Shared constant "${constLabel}" not bumped: ` +
        `${unresolvable.join(", ")} has no version ${proposedVersion}. ` +
        `Dropping: ${listing}`,
      );
      droppedKeys.add(key);
    }
  }

  // Remove candidates whose constant was dropped (iterate in reverse to safely splice)
  if (droppedKeys.size > 0) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (!STARLARK_ECOSYSTEMS.has(c.dep.ecosystem)) continue;
      const key = constantKeyOf(c.dep, fileRealpaths);
      if (key && droppedKeys.has(key)) candidates.splice(i, 1);
    }
  }
}

/** Maven existence check for the java ecosystem. */
export const javaExistenceCheck: ExistenceCheck = (name, version, repos, registries) => {
  const [g, a] = name.split(":");
  if (!g || !a) return Promise.resolve(false);
  return mavenArtifactExists(g, a, version, repos, registries);
};

/** crates.io existence check for the rust ecosystem. */
export const rustExistenceCheck: ExistenceCheck = async (name, version, _repos, registries) => {
  const versions = await cratesVersions(name, registries);
  return versions.some((v) => v.version === version);
};

/** Build a BCR existence check for the bazel ecosystem bound to a token + URL. */
export function makeBazelExistenceCheck(token: string, bcrUrl: string): ExistenceCheck {
  return async (name, version) => {
    const versions = await bcrVersions(name, token, bcrUrl);
    return versions.some((v) => v.version === version);
  };
}

/**
 * Maven age check for the java ecosystem — used by {@link reconcileConstantGroups} to
 * age-gate (not just existence-check) a shared-constant's proposed version for every
 * referencing dep, since publish dates differ per registry for the same version string.
 */
export const javaAgeCheck: AgeCheck = async (name, version, repos, registries) => {
  const [g, a] = name.split(":");
  if (!g || !a) return null;
  return computeAgeDays(await mavenPublishDate(g, a, version, repos, registries));
};

/** crates.io age check for the rust ecosystem. */
export const rustAgeCheck: AgeCheck = async (name, version, _repos, registries) => {
  const versions = await cratesVersions(name, registries);
  const entry = versions.find((v) => v.version === version);
  return entry ? computeAgeDays(entry.publishDate) : null;
};

/** Build a BCR age check for the bazel ecosystem bound to a token + URL. */
export function makeBazelAgeCheck(token: string, bcrUrl: string): AgeCheck {
  return async (name, version) => computeAgeDays(await bcrPublishDate(name, version, token, bcrUrl));
}
