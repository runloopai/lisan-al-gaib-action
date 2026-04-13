import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  resolveModuleFiles,
  extractMavenInstalls,
} from "../bazel.js";
import { gitShowFile } from "../diff.js";
import { mavenPublishDate } from "../registry.js";
import type { RegistryUrls } from "../inputs.js";
import type { ChangedDep, MavenInstall } from "./types.js";

interface ArtifactMap {
  [key: string]: string; // "group:artifact" -> "version"
}

function parseArtifacts(json: string): ArtifactMap {
  try {
    const data = JSON.parse(json);
    const result: ArtifactMap = {};
    if (data.artifacts) {
      for (const [key, value] of Object.entries(data.artifacts)) {
        const v = (value as { version?: string })?.version;
        if (v) result[key] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function getChangedDeps(
  baseRef: string,
  moduleBazelPath: string,
): Promise<{ deps: ChangedDep[]; repositories: Map<string, string[]> }> {
  const moduleFiles = await resolveModuleFiles(moduleBazelPath);
  const workspaceRoot = path.resolve(path.dirname(moduleBazelPath));
  const allInstalls: MavenInstall[] = [];

  for (const file of moduleFiles) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    allInstalls.push(...(await extractMavenInstalls(content, workspaceRoot)));
  }

  if (allInstalls.length === 0) {
    core.info("java: no maven.install() blocks found");
    return { deps: [], repositories: new Map() };
  }

  const allDeps: ChangedDep[] = [];
  // Map from "group:artifact" to repositories list for registry queries
  const repoMap = new Map<string, string[]>();

  for (const install of allInstalls) {
    const lockFile = install.lockFile;

    let headJson: string;
    try {
      headJson = await fs.readFile(lockFile, "utf8");
    } catch {
      core.info(`java: lock file ${lockFile} not found, skipping`);
      continue;
    }

    const headArtifacts = parseArtifacts(headJson);
    const baseJson = await gitShowFile(baseRef, lockFile);
    const baseArtifacts = baseJson ? parseArtifacts(baseJson) : {};

    for (const [key, version] of Object.entries(headArtifacts)) {
      if (baseArtifacts[key] === version) continue;

      allDeps.push({
        ecosystem: "java",
        name: key,
        version,
        file: lockFile,
      });

      repoMap.set(key, install.repositories);
    }
  }

  return { deps: allDeps, repositories: repoMap };
}

export async function getPublishDate(
  name: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<Date | null> {
  const parts = name.split(":");
  if (parts.length !== 2) return null;
  return mavenPublishDate(parts[0], parts[1], version, repositories, registries);
}
