import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import semver from "semver";
import {
  resolveModuleFiles,
  extractCrateSpecs,
} from "../bazel.js";
import { gitDiffNameOnly, gitShowFile } from "../diff.js";
import { cratesPublishDate } from "../registry.js";
import type { RegistryUrls } from "../inputs.js";
import type { ChangedDep, CrateSpec } from "./types.js";

function specKey(s: CrateSpec): string {
  return `${s.package}@${s.version}`;
}

/**
 * Build a map of crate name → resolved exact versions from MODULE.bazel.lock.
 * Reads the crate_universe extension's generatedRepoSpecs and extracts the
 * version from each crate's static.crates.io download URL.
 */
export function parseCrateLockVersions(content: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  try {
    const data = JSON.parse(content);
    const moduleExtensions = data?.moduleExtensions;
    if (!moduleExtensions || typeof moduleExtensions !== "object") return result;

    // Match the crate_universe extension key regardless of the +/~ canonical separator
    // or the exact rules_rust module name (robust to forks and Bazel version changes).
    const extKey = Object.keys(moduleExtensions).find(
      (k) => /crate_universe[^%]*%crate$/.test(k),
    );
    if (!extKey) return result;

    const ext = moduleExtensions[extKey];

    // Collect all eval results — crate_universe always uses "general" but handle
    // future platform-split locks by iterating all sub-keys.
    const evalResults: unknown[] = ext?.general
      ? [ext.general]
      : Object.values(ext ?? {});

    for (const evalResult of evalResults) {
      const repoSpecs = (evalResult as Record<string, unknown>)?.generatedRepoSpecs;
      if (!repoSpecs || typeof repoSpecs !== "object") continue;
      for (const spec of Object.values(repoSpecs)) {
        const urls = (spec as Record<string, unknown>)?.attributes as Record<string, unknown>;
        const urlList = urls?.urls;
        if (!Array.isArray(urlList) || urlList.length === 0) continue;
        const url = urlList[0];
        if (typeof url !== "string") continue;
        // URL: https://static.crates.io/crates/<name>/<version>/download
        // Using the URL (not the repo key) avoids the hyphen-in-name ambiguity.
        const m = url.match(/\/crates\/([^/]+)\/([^/]+)\/download/);
        if (!m) continue;
        const [, name, version] = m;
        const arr = result.get(name) ?? [];
        arr.push(version);
        result.set(name, arr);
      }
    }
  } catch (e) {
    core.debug(`rust: failed to parse MODULE.bazel.lock for crate versions: ${e}`);
  }
  return result;
}

/**
 * Convert a Cargo version requirement to a form npm's semver package understands.
 * Key differences handled:
 * - Cargo uses ',' as an AND separator; npm semver uses a space.
 * - A bare version ("1.2.3" with no operator) means caret (^) in Cargo but exact in npm semver.
 */
export function cargoReqToNpmRange(req: string): string {
  // Replace Cargo AND separator
  let r = req.replace(/,/g, " ").trim();
  // Bare single-term numeric req (no operator, no wildcard) → treat as caret (Cargo semantics)
  if (/^\d[^\s]*$/.test(r) && !r.includes("*") && !r.includes("x")) {
    r = "^" + r;
  }
  return r;
}

/**
 * Resolve a crate.spec range to the concrete version pinned in MODULE.bazel.lock.
 * Falls back to the raw range on any resolution failure so that the version is
 * never incorrectly changed (worst-case: registry lookup returns null → "unknown",
 * same as before this fix).
 */
export function resolveCrateVersion(
  name: string,
  range: string,
  lockVersions: Map<string, string[]>,
): string {
  const versions = lockVersions.get(name);
  if (!versions || versions.length === 0) return range;
  const npmRange = cargoReqToNpmRange(range);
  const best = semver.maxSatisfying(versions, npmRange, { loose: true });
  return best ?? range;
}

export async function getChangedDeps(
  baseRef: string,
  moduleBazelPath: string,
): Promise<ChangedDep[]> {
  const moduleFiles = await resolveModuleFiles(moduleBazelPath);
  if (moduleFiles.length === 0) {
    core.info("rust: no MODULE.bazel files found");
    return [];
  }

  const changedFiles = new Set(await gitDiffNameOnly(baseRef));
  const relevantFiles = moduleFiles.filter((f) => changedFiles.has(f));

  if (relevantFiles.length === 0) {
    core.info("rust: no MODULE.bazel files changed");
    return [];
  }

  // Resolve crate.spec ranges to concrete versions using MODULE.bazel.lock at the workspace root.
  const lockPath = moduleBazelPath + ".lock";
  let lockVersions = new Map<string, string[]>();
  try {
    const lockContent = await fs.readFile(lockPath, "utf8");
    lockVersions = parseCrateLockVersions(lockContent);
  } catch {
    core.debug(`rust: could not read MODULE.bazel.lock at ${lockPath}; version ranges will not be resolved`);
  }

  const allDeps: ChangedDep[] = [];

  for (const file of relevantFiles) {
    // Parse HEAD version
    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const headSpecs = await extractCrateSpecs(headContent);

    // Parse base version
    const baseContent = await gitShowFile(baseRef, file);
    const baseSpecs = baseContent ? await extractCrateSpecs(baseContent) : [];
    const baseKeys = new Set(baseSpecs.map(specKey));

    // Find new or changed crate specs
    for (const spec of headSpecs) {
      if (spec.isGit) continue;
      if (baseKeys.has(specKey(spec))) continue;

      allDeps.push({
        ecosystem: "rust",
        name: spec.package,
        version: resolveCrateVersion(spec.package, spec.version, lockVersions),
        file,
      });
    }
  }

  return allDeps;
}

export async function getPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  return cratesPublishDate(name, version, registries);
}
