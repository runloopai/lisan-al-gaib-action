import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { resolveModuleFiles, extractOverrides } from "../bazel.js";
import { gitDiff, gitShowFile } from "../diff.js";
import type { ChangedDep, BazelOverride } from "./types.js";

interface ModuleDepEntry {
  name: string;
  version: string;
}

export function parseModuleLock(content: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const data = JSON.parse(content);

    // v3 format: moduleDepGraph with name/version entries
    const graph = data.moduleDepGraph;
    if (graph && typeof graph === "object") {
      for (const [key, value] of Object.entries(graph)) {
        if (key === "" || key === "<root>") continue;
        const entry = value as ModuleDepEntry;
        if (entry.name && entry.version) {
          result.set(entry.name, entry.version);
        }
      }
      return result;
    }

    // v24+ format: modules with source.json in registryFileHashes
    // are the resolved/selected modules
    const rfh = data.registryFileHashes;
    if (rfh && typeof rfh === "object") {
      for (const url of Object.keys(rfh)) {
        const match = url.match(/\/modules\/([^/]+)\/([^/]+)\/source\.json$/);
        if (match) {
          result.set(match[1], match[2]);
        } else if (url.endsWith("source.json")) {
          core.debug(`bazel: unexpected source.json URL format, skipping: ${url}`);
        }
      }
    }
  } catch (e) {
    core.debug(`Failed to parse MODULE.bazel.lock: ${e}`);
  }
  return result;
}

export async function getChangedDeps(
  baseRef: string,
  moduleBazelPath: string,
): Promise<{
  deps: ChangedDep[];
  overrides: Map<string, BazelOverride>;
}> {
  const lockfilePath = moduleBazelPath + ".lock";

  // Check if lockfile changed
  const diff = await gitDiff(baseRef, lockfilePath);
  if (!diff) {
    core.info("bazel: MODULE.bazel.lock not changed");
    return { deps: [], overrides: new Map() };
  }

  // Parse HEAD lockfile
  let headContent: string;
  try {
    headContent = await fs.readFile(lockfilePath, "utf8");
  } catch {
    core.info(`bazel: could not read ${lockfilePath}`);
    return { deps: [], overrides: new Map() };
  }

  const headModules = parseModuleLock(headContent);
  const baseContent = await gitShowFile(baseRef, lockfilePath);
  const baseModules = baseContent ? parseModuleLock(baseContent) : new Map<string, string>();

  // Collect overrides from all MODULE.bazel files
  const allOverrides = new Map<string, BazelOverride>();
  const moduleFiles = await resolveModuleFiles(moduleBazelPath);
  for (const file of moduleFiles) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const fileOverrides = await extractOverrides(content);
    for (const [name, override] of fileOverrides) {
      allOverrides.set(name, override);
    }
  }

  // Find changed modules
  const deps: ChangedDep[] = [];
  for (const [name, version] of headModules) {
    if (baseModules.get(name) === version) continue;

    // Skip local_path_override modules
    const override = allOverrides.get(name);
    if (override?.type === "local_path") {
      core.info(`bazel: skipping ${name} (local_path_override)`);
      continue;
    }

    deps.push({
      ecosystem: "bazel",
      name,
      version,
      file: lockfilePath,
    });
  }

  return { deps, overrides: allOverrides };
}
