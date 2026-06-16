import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as actionsGlob from "@actions/glob";
import { resolveFiles } from "../../diff.js";
import { resolveModuleFiles } from "../../bazel.js";

/**
 * Glob exclusion patterns applied to all default file-discovery globs in the
 * updater. Defined once here so docker.ts, kubernetes.ts (and any future
 * ecosystems) stay in sync without copy-paste drift.
 */
export const DEFAULT_GLOB_EXCLUSIONS = [
  "!**/node_modules/**",
  "!**/.git/**",
  "!**/dist/**",
  "!**/cli-dist/**",
  "!**/out/**",
  "!**/.lisan-tmp-*",
];

/**
 * Compute the absolute UTF-16 code-unit offset at the start of each line in
 * `content`. offsets[i] is the offset of line i (0-based). Used to convert
 * (lineIndex, lineOffset) positions to absolute file offsets for rewrites.
 */
export function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Group items by their dep's source file. Items whose file is undefined are
 * skipped (they cannot be written back).
 */
export function groupByFile<T extends { dep: { file?: string } }>(
  items: T[],
): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const file = item.dep.file;
    if (file === undefined) continue;
    const arr = byFile.get(file) ?? [];
    arr.push(item);
    byFile.set(file, arr);
  }
  return byFile;
}

/**
 * Read each file in `files`, warning and skipping on read failure.
 * Returns an array of `{ file, content }` for each file that was successfully read.
 * `label` is the ecosystem name used in warning messages (e.g. "docker", "kubernetes").
 */
export async function readFilesSafe(
  files: string[],
  label: string,
): Promise<Array<{ file: string; content: string }>> {
  const results: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      core.warning(`${label}: could not read ${file}`);
      continue;
    }
    results.push({ file, content });
  }
  return results;
}

/**
 * Resolve a MODULE.bazel file (following `include()` directives) and read each
 * resulting file's content, warning on individual read failures. Wraps the identical
 * `resolveModuleFiles` + `readFilesSafe` loop that rust/java/bazel updaters previously
 * repeated verbatim, so they stay structurally consistent with docker/kubernetes/actions.
 *
 * Returns an array of `{ file, content }` for every file that was resolved and read.
 * If `resolveModuleFiles` itself throws (path not found, parse error), logs via `label`
 * and returns an empty array rather than propagating.
 */
export async function readModuleFilesSafe(
  moduleBazelPath: string,
  label: string,
): Promise<Array<{ file: string; content: string }>> {
  let moduleFiles: string[];
  try {
    moduleFiles = await resolveModuleFiles(moduleBazelPath);
  } catch {
    core.warning(`${label}: failed to resolve MODULE.bazel files from ${moduleBazelPath}`);
    return [];
  }
  return readFilesSafe(moduleFiles, label);
}

/**
 * Resolve a list of files either from a user-provided glob string or from a
 * default glob pattern, returning relative paths. Used by docker.ts and kubernetes.ts
 * to eliminate boilerplate in their `discover()` functions.
 */
export async function discoverViaGlobs(opts: {
  inputGlob: string | undefined;
  defaultPattern: string;
  label: string;
}): Promise<string[]> {
  const { inputGlob, defaultPattern, label } = opts;
  if (inputGlob) {
    try {
      return await resolveFiles(inputGlob);
    } catch {
      core.warning(`${label}: failed to resolve ${label} files glob`);
      return [];
    }
  }
  try {
    const cwd = process.cwd();
    const globber = await actionsGlob.create(defaultPattern, { followSymbolicLinks: false });
    const matched = await globber.glob();
    return matched.map((f) => path.relative(cwd, f));
  } catch {
    core.warning(`${label}: failed to resolve default ${label} globs`);
    return [];
  }
}
