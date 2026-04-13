import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveModuleFiles, extractMultitoolHubs } from "../bazel.js";
import { gitDiff, gitShowFile } from "../diff.js";
import { archiveDate } from "../registry.js";
import type { ChangedDep, MultitoolBinary } from "./types.js";

export function parseMultitoolLock(content: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const data = JSON.parse(content) as Record<string, { binaries?: MultitoolBinary[] }>;
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("$")) continue;
      const firstUrl = value?.binaries?.[0]?.url;
      if (firstUrl) {
        result.set(key, firstUrl);
      }
    }
  } catch (e) {
    core.debug(`Failed to parse multitool lockfile: ${e}`);
  }
  return result;
}

export function findChangedTools(
  head: Map<string, string>,
  base: Map<string, string>,
  file: string,
): ChangedDep[] {
  const deps: ChangedDep[] = [];
  for (const [name, url] of head) {
    if (base.get(name) === url) continue;
    deps.push({
      ecosystem: "multitool",
      name,
      version: url,
      file,
    });
  }
  return deps;
}

export async function getChangedDeps(
  baseRef: string,
  moduleBazelPath: string,
): Promise<ChangedDep[]> {
  const moduleFiles = await resolveModuleFiles(moduleBazelPath);
  const workspaceRoot = path.resolve(path.dirname(moduleBazelPath));
  const lockfiles: string[] = [];
  for (const file of moduleFiles) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const hubs = await extractMultitoolHubs(content, workspaceRoot);
    lockfiles.push(...hubs);
  }

  if (lockfiles.length === 0) {
    core.info("multitool: no lockfiles found");
    return [];
  }

  const allDeps: ChangedDep[] = [];

  for (const file of lockfiles) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) {
      core.info(`multitool: no changes in ${file}`);
      continue;
    }

    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`multitool: could not read ${file}`);
      continue;
    }

    const headTools = parseMultitoolLock(headContent);
    const baseContent = await gitShowFile(baseRef, file);
    const baseTools = baseContent ? parseMultitoolLock(baseContent) : new Map<string, string>();

    allDeps.push(...findChangedTools(headTools, baseTools, file));
  }

  return allDeps;
}

export async function getPublishDate(url: string): Promise<Date | null> {
  return archiveDate(url);
}
