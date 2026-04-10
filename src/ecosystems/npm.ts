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
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "pnpm";
  return "npm";
}

/** Flatten a parsed lockfile into a map of name -> version. */
function collectPackages(deps: ParsedDependency[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const dep of deps) {
    result.set(dep.name, dep.version);
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

  let headPkgs: Map<string, string>;
  try {
    const parsed = await parseLockfile(headContent, type);
    headPkgs = collectPackages(parsed.packages);
  } catch (e) {
    core.warning(`Failed to parse ${file}: ${e}`);
    return [];
  }

  let basePkgs = new Map<string, string>();
  if (baseContent) {
    try {
      const parsed = await parseLockfile(baseContent, type);
      basePkgs = collectPackages(parsed.packages);
    } catch {
      // Base couldn't be parsed (new file, etc.) — treat all HEAD packages as new
    }
  }

  const deps: ChangedDep[] = [];
  for (const [name, version] of headPkgs) {
    if (basePkgs.get(name) === version) continue;
    deps.push({ ecosystem: "npm", name, version, file });
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
