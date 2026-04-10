import * as core from "@actions/core";
import * as fs from "node:fs/promises";
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
        version: spec.version,
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
