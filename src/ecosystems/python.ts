import * as core from "@actions/core";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import { pypiPublishDate } from "../registry.js";
import type { RegistryUrls } from "../inputs.js";
import type { ChangedDep } from "./types.js";

type LockFormat = "uv" | "pylock";

/** Normalize PyPI package names per PEP 503: case-insensitive, [-_.] equivalent. */
function normalizePypiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

function detectFormat(file: string): LockFormat {
  const base = path.basename(file);
  if (base === "pylock.toml" || base.startsWith("pylock.")) return "pylock";
  return "uv"; // uv.lock and *.py.lock (script lockfiles)
}

interface UvPackage {
  name?: string;
  version?: string;
  source?: { registry?: string; editable?: string; directory?: string; virtual?: string };
}

interface PylockPackage {
  name?: string;
  version?: string;
}

/** Parse uv.lock (TOML with [[package]] arrays) */
function parseUvLock(content: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const data = parseToml(content) as { package?: UvPackage[] };
    if (Array.isArray(data.package)) {
      for (const pkg of data.package) {
        if (!pkg.name || !pkg.version) continue;
        // Skip local/editable/virtual packages (workspace deps)
        const src = pkg.source;
        if (src && (src.editable || src.directory || src.virtual)) continue;
        result.set(normalizePypiName(pkg.name), pkg.version);
      }
    }
  } catch (e) {
    core.debug(`Failed to parse uv.lock as TOML: ${e}`);
  }
  return result;
}

/** Parse pylock.toml (PEP 751 format with [[packages]] arrays) */
function parsePylockToml(content: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const data = parseToml(content) as { packages?: PylockPackage[] };
    if (Array.isArray(data.packages)) {
      for (const pkg of data.packages) {
        if (pkg.name && pkg.version) {
          result.set(normalizePypiName(pkg.name), pkg.version);
        }
      }
    }
  } catch (e) {
    core.debug(`Failed to parse pylock.toml: ${e}`);
  }
  return result;
}

function parsePythonLock(
  content: string,
  format: LockFormat,
): Map<string, string> {
  switch (format) {
    case "uv":
      return parseUvLock(content);
    case "pylock":
      return parsePylockToml(content);
  }
}

/** Compare HEAD and base lockfile to find new/changed packages. */
export function findChangedPackages(
  headContent: string,
  baseContent: string | null,
  file: string,
): ChangedDep[] {
  const format = detectFormat(file);
  const headPkgs = parsePythonLock(headContent, format);

  let basePkgs = new Map<string, string>();
  if (baseContent) {
    basePkgs = parsePythonLock(baseContent, format);
  }

  const deps: ChangedDep[] = [];
  for (const [name, version] of headPkgs) {
    if (basePkgs.get(name) === version) continue;
    deps.push({ ecosystem: "python", name, version, file });
  }

  return deps;
}

const DEFAULT_LOCKFILES = ["uv.lock", "pylock.toml"];

/** Check if a file path looks like a Python lockfile we handle. */
function isPythonLockfile(file: string): boolean {
  const base = path.basename(file);
  if (DEFAULT_LOCKFILES.includes(base)) return true;
  // uv lock --script creates *.py.lock adjacent to the script
  if (base.endsWith(".py.lock")) return true;
  return false;
}

export async function getChangedDeps(
  baseRef: string,
  lockfileInput: string,
): Promise<ChangedDep[]> {
  let lockfiles: string[];

  if (lockfileInput) {
    const allLockfiles = new Set(await resolveFiles(lockfileInput));
    const changedFiles = await gitDiffNameOnly(baseRef);
    lockfiles = changedFiles.filter((f) => allLockfiles.has(f));
  } else {
    // Auto-detect: find changed lockfiles (known names + *.py.lock pattern)
    const changedFiles = await gitDiffNameOnly(baseRef);
    lockfiles = changedFiles.filter((f) => isPythonLockfile(f));
  }

  if (lockfiles.length === 0) {
    core.info("python: no changed lockfiles");
    return [];
  }

  const allDeps: ChangedDep[] = [];
  for (const file of lockfiles) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) continue;

    // Read full HEAD and base content for proper parsing
    let headContent: string;
    try {
      const fs = await import("node:fs/promises");
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`python: could not read ${file}`);
      continue;
    }

    const baseContent = await gitShowFile(baseRef, file);
    allDeps.push(...findChangedPackages(headContent, baseContent, file));
  }

  return allDeps;
}

export async function getPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  return pypiPublishDate(name, version, registries);
}
