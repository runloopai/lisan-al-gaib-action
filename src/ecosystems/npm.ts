import * as core from "@actions/core";
import * as path from "node:path";
import { parse as parseLockfile } from "lockparse";
import type { ParsedDependency } from "lockparse";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import { npmPublishDate } from "../registry.js";
import type { RegistryUrls } from "../inputs.js";
import type { ChangedDep } from "./types.js";

/** Default lockfile names to auto-detect when no explicit input is provided. */
const DEFAULT_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
];

type LockType = "npm" | "pnpm" | "yarn" | "bun";

function detectType(file: string): LockType {
  const base = path.basename(file);
  if (base === "pnpm-lock.yaml") return "pnpm";
  if (base === "package-lock.json") return "npm";
  if (base === "yarn.lock") return "yarn";
  if (base === "bun.lock") return "bun";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) {
    core.debug(`npm: treating ${file} as pnpm lockfile based on extension`);
    return "pnpm";
  }
  core.debug(`npm: treating ${file} as npm lockfile (default fallback)`);
  return "npm";
}

/**
 * Resolve npm aliases. In pnpm lockfiles, aliased packages like
 * `string-width-cjs: string-width@4.2.3` produce version = "string-width@4.2.3".
 * Returns [resolvedName, resolvedVersion].
 */
function resolveAlias(name: string, version: string): [string, string] {
  // Pattern: version contains "@" with a real package name prefix
  // e.g. "string-width@4.2.3" or "@scope/pkg@1.0.0"
  const atIdx = version.startsWith("@")
    ? version.indexOf("@", 1)  // scoped: find second @
    : version.indexOf("@");
  if (atIdx > 0) {
    const realName = version.slice(0, atIdx);
    const realVersion = version.slice(atIdx + 1);
    // Sanity check: realVersion should look like a version (starts with digit)
    if (/^\d/.test(realVersion)) {
      return [realName, realVersion];
    }
  }
  return [name, version];
}

/** Resolved package entry preserving the original key for diffing. */
interface ResolvedPkg {
  /** Original name from lockfile (used as Map key for base vs head comparison) */
  key: string;
  /** Resolved name for registry lookups (same as key unless aliased) */
  name: string;
  version: string;
}

/** Flatten a parsed lockfile into resolved package entries. */
function collectPackages(deps: ParsedDependency[]): Map<string, ResolvedPkg> {
  const result = new Map<string, ResolvedPkg>();
  for (const dep of deps) {
    const [name, version] = resolveAlias(dep.name, dep.version);
    result.set(dep.name, { key: dep.name, name, version });
  }
  return result;
}

/** Compare HEAD and base lockfile contents to find new/changed packages. */
export async function findChangedPackages(
  headContent: string,
  baseContent: string | null,
  file: string,
): Promise<ChangedDep[]> {
  const type = detectType(file);

  let headPkgs: Map<string, ResolvedPkg>;
  try {
    const parsed = await parseLockfile(headContent, type);
    headPkgs = collectPackages(parsed.packages);
  } catch (e) {
    core.warning(`Failed to parse ${file}: ${e}`);
    return [];
  }

  let basePkgs = new Map<string, ResolvedPkg>();
  if (baseContent) {
    try {
      const parsed = await parseLockfile(baseContent, type);
      basePkgs = collectPackages(parsed.packages);
    } catch {
      // Base couldn't be parsed (new file, etc.) — treat all HEAD packages as new
    }
  }

  const deps: ChangedDep[] = [];
  for (const [key, pkg] of headPkgs) {
    const basePkg = basePkgs.get(key);
    if (basePkg && basePkg.version === pkg.version) continue;
    // Use resolved name for registry lookups
    deps.push({ ecosystem: "npm", name: pkg.name, version: pkg.version, file });
  }

  return deps;
}

export async function getChangedDeps(
  baseRef: string,
  lockfileInput: string,
): Promise<ChangedDep[]> {
  let files: string[];

  if (lockfileInput) {
    files = await resolveFiles(lockfileInput);
  } else {
    // Auto-detect: find which default lockfiles were changed
    const changedFiles = new Set(await gitDiffNameOnly(baseRef));
    files = DEFAULT_LOCKFILES.filter((f) => changedFiles.has(f));
    if (files.length === 0) {
      core.info("npm: no lockfiles found in changed files");
      return [];
    }
  }

  const allDeps: ChangedDep[] = [];

  for (const file of files) {
    // Check if file changed at all
    const diff = await gitDiff(baseRef, file);
    if (!diff) {
      core.info(`npm: no changes in ${file}`);
      continue;
    }

    // Read full HEAD and base content for proper parsing
    let headContent: string;
    try {
      const fs = await import("node:fs/promises");
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`npm: could not read ${file}`);
      continue;
    }

    const baseContent = await gitShowFile(baseRef, file);
    allDeps.push(...(await findChangedPackages(headContent, baseContent, file)));
  }

  return allDeps;
}

export async function getPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  return npmPublishDate(name, version, registries);
}
