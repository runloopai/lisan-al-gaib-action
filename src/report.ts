import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import semver from "semver";
import yaml from "js-yaml";
import type { CheckResult, DepStatus } from "./ecosystems/types.js";
import type { LicenseResult } from "./license.js";

function getBranding(): string {
  try {
    const owner = github.context.repo.owner;
    if (owner === "runloopai") return "";
  } catch {
    // GITHUB_REPOSITORY not set (e.g., local/test)
  }
  return "\n\n---\nMade with 💚 by [Runloop AI](https://runloop.ai)\n";
}

export function determineStatus(
  ageDays: number | null,
  minAgeDays: number,
  warnAgeDays: number,
): DepStatus {
  if (ageDays === null) return "unknown";
  if (ageDays < minAgeDays) return "fail";
  if (ageDays < warnAgeDays) return "warn";
  return "pass";
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Quote a string for YAML if needed, using js-yaml's serializer. */
function yamlQuote(s: string): string {
  return yaml.dump(s, { flowLevel: 0 }).trimEnd();
}

// ── Age-gate remediation via git diff ──────────────────────────────────

/**
 * Write a modified file, run `git diff -u --color`, then restore the original.
 * Returns true if a diff was shown.
 */
/** Show a diff wrapped in a named group. */
async function showGroupDiff(filePath: string, original: string, modified: string, groupName: string): Promise<boolean> {
  if (original === modified) return false;
  try {
    core.startGroup(groupName);
    await fs.writeFile(filePath, modified, "utf8");
    await exec.exec("git", ["diff", "-u", "--color", filePath], { silent: false });
    core.endGroup();
    return true;
  } finally {
    await fs.writeFile(filePath, original, "utf8");
  }
}

async function showDiff(filePath: string, original: string | null, modified: string): Promise<boolean> {
  if (original === modified) return false;
  const isNew = original === null;
  try {
    await fs.writeFile(filePath, modified, "utf8");
    if (isNew) {
      // Intent-to-add so git diff can see the new file
      await exec.exec("git", ["add", "-N", filePath], { silent: true });
    }
    await exec.exec("git", ["diff", "-u", "--color", filePath], { silent: false });
    return true;
  } finally {
    if (isNew) {
      await exec.exec("git", ["reset", filePath], { silent: true });
      await fs.unlink(filePath).catch(() => {});
    } else {
      await fs.writeFile(filePath, original, "utf8");
    }
  }
}

/**
 * Get the installed version of a CLI tool, or null if not found.
 */
async function getToolVersion(tool: string): Promise<string | null> {
  try {
    let stdout = "";
    await exec.exec(tool, ["--version"], {
      listeners: { stdout: (data) => (stdout += data.toString()) },
      silent: true,
    });
    const match = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver-ish version strings (major.minor or major.minor.patch).
 * Returns true if `actual` >= `required`.
 */
export function versionAtLeast(actual: string, required: string): boolean {
  const a = actual.split(".").map(Number);
  const r = required.split(".").map(Number);
  for (let i = 0; i < r.length; i++) {
    const av = a[i] ?? 0;
    const rv = r[i] ?? 0;
    if (isNaN(av) || isNaN(rv)) return false;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true;
}

/**
 * Return a friendly duration string for uv exclude-newer (e.g. "14 days").
 */
function excludeNewerDuration(minAgeDays: number): string {
  return `${minAgeDays} days`;
}

/**
 * Parse an existing exclude-newer value into a number of days.
 * Handles: "14 days", "P14D", and RFC 3339 timestamps.
 * Returns null if unparseable.
 */
export function parseExcludeNewerDays(value: string): number | null {
  // Friendly: "14 days"
  const friendlyMatch = value.match(/^(\d+)\s*days?$/i);
  if (friendlyMatch) return parseInt(friendlyMatch[1], 10);
  // ISO 8601 duration: "P14D"
  const isoMatch = value.match(/^P(\d+)D$/i);
  if (isoMatch) return parseInt(isoMatch[1], 10);
  // RFC 3339 timestamp: compute days from now
  const ts = Date.parse(value);
  if (!isNaN(ts)) return Math.floor((Date.now() - ts) / 86_400_000);
  return null;
}

/**
 * Resolve the uv config file for a workspace root directory.
 * If uv.toml exists, use it (higher precedence per uv docs).
 * Otherwise use pyproject.toml — even if it lacks [tool.uv] (we'll suggest adding it).
 * Returns null only if neither file exists.
 */
async function resolveUvConfig(dir: string): Promise<{
  file: string;
  content: string;
  uvConfig: Record<string, unknown> | null;
  isUvToml: boolean;
} | null> {
  // Try uv.toml first (higher precedence)
  const uvTomlPath = path.join(dir, "uv.toml");
  try {
    const content = await fs.readFile(uvTomlPath, "utf8");
    const data = parseToml(content);
    return { file: uvTomlPath, content, uvConfig: data, isUvToml: true };
  } catch { /* not found or parse error */ }

  // Fall back to pyproject.toml
  const pyprojectPath = path.join(dir, "pyproject.toml");
  try {
    const content = await fs.readFile(pyprojectPath, "utf8");
    const data = parseToml(content);
    const toolUv = (data.tool as Record<string, unknown> | undefined)?.uv as
      Record<string, unknown> | undefined;
    return { file: pyprojectPath, content, uvConfig: toolUv ?? null, isUvToml: false };
  } catch { /* not found or parse error */ }

  return null;
}

/**
 * Check a uv config file: if it's missing exclude-newer or its value is
 * more recent than the cutoff, suggest adding/updating it.
 */
async function suggestUvExcludeNewer(dir: string, minAgeDays: number): Promise<boolean> {
  const cfg = await resolveUvConfig(dir);
  if (!cfg) return false;

  const { file, content, uvConfig, isUvToml } = cfg;
  const duration = excludeNewerDuration(minAgeDays);
  const existing = uvConfig?.["exclude-newer"] as string | undefined;
  if (existing) {
    const existingDays = parseExcludeNewerDays(existing);
    if (existingDays !== null && existingDays >= minAgeDays) return false; // already strict enough
  }

  const lines = content.split("\n");
  let modified: string;

  if (existing) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith("exclude-newer") && !l.trimStart().startsWith("exclude-newer-package"));
    if (idx === -1) return false;
    const indent = lines[idx].match(/^(\s*)/)?.[1] ?? "";
    lines[idx] = `${indent}exclude-newer = "${duration}"`;
    modified = lines.join("\n");
  } else if (isUvToml) {
    // uv.toml — insert after leading comments
    let insertIdx = 0;
    while (insertIdx < lines.length && (lines[insertIdx].startsWith("#") || lines[insertIdx].trim() === "")) {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, `exclude-newer = "${duration}"`);
    modified = lines.join("\n");
  } else {
    // pyproject.toml — insert after [tool.uv], or add the section if missing
    const uvIdx = lines.findIndex((l) => l.trim() === "[tool.uv]");
    if (uvIdx !== -1) {
      lines.splice(uvIdx + 1, 0, `exclude-newer = "${duration}"`);
    } else {
      // Append [tool.uv] section at the end
      lines.push("", "[tool.uv]", `exclude-newer = "${duration}"`);
    }
    modified = lines.join("\n");
  }

  return showDiff(file, content, modified);
}

/**
 * Suggest pnpm minimumReleaseAge in pnpm-workspace.yaml.
 * Uses yaml.load to parse; targeted line edit for writing.
 */
async function suggestPnpmAge(minAgeDays: number): Promise<boolean> {
  const ver = await getToolVersion("pnpm");
  if (ver && !versionAtLeast(ver, "10.16")) {
    core.info(`pnpm ${ver} does not support minimumReleaseAge (requires >= 10.16)`);
    return false;
  }
  const file = "pnpm-workspace.yaml";
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }

  const targetMinutes = minAgeDays * 24 * 60;
  let data: Record<string, unknown>;
  try {
    data = yaml.load(content) as Record<string, unknown> ?? {};
  } catch {
    return false;
  }

  const existing = data.minimumReleaseAge as number | undefined;
  if (existing !== undefined && existing >= targetMinutes) return false;

  const setting = `minimumReleaseAge: ${targetMinutes}  # ${minAgeDays} days, in minutes`;
  const lines = content.split("\n");
  let modified: string;

  if (existing !== undefined) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith("minimumReleaseAge"));
    if (idx === -1) return false;
    lines[idx] = setting;
    modified = lines.join("\n");
  } else {
    modified = content.trimEnd() + "\n" + setting + "\n";
  }

  return showDiff(file, content, modified);
}

/**
 * Suggest yarn npmMinimalAgeGate in .yarnrc.yml.
 * Uses yaml.load to parse; targeted line edit for writing.
 */
async function suggestYarnAge(minAgeDays: number): Promise<boolean> {
  const ver = await getToolVersion("yarn");
  if (ver && !versionAtLeast(ver, "4.10")) {
    core.info(`yarn ${ver} does not support npmMinimalAgeGate (requires >= 4.10)`);
    return false;
  }
  const file = ".yarnrc.yml";
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }

  let data: Record<string, unknown>;
  try {
    data = yaml.load(content) as Record<string, unknown> ?? {};
  } catch {
    return false;
  }

  const existing = data.npmMinimalAgeGate as string | undefined;
  if (existing) {
    const days = parseInt(existing, 10);
    if (!isNaN(days) && days >= minAgeDays) return false;
  }

  const setting = `npmMinimalAgeGate: "${minAgeDays}d"`;
  const lines = content.split("\n");
  let modified: string;

  if (existing) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith("npmMinimalAgeGate"));
    if (idx === -1) return false;
    lines[idx] = setting;
    modified = lines.join("\n");
  } else {
    modified = content.trimEnd() + "\n" + setting + "\n";
  }

  return showDiff(file, content, modified);
}

/**
 * Suggest bun minimumReleaseAge in bunfig.toml.
 * Uses smol-toml to parse; targeted line edit for writing.
 */
async function suggestBunAge(minAgeDays: number): Promise<boolean> {
  const ver = await getToolVersion("bun");
  if (ver && !versionAtLeast(ver, "1.3")) {
    core.info(`bun ${ver} does not support minimumReleaseAge (requires >= 1.3)`);
    return false;
  }
  const file = "bunfig.toml";
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }

  const targetSeconds = minAgeDays * 86_400;
  let data: Record<string, unknown>;
  try {
    data = parseToml(content);
  } catch {
    return false;
  }

  const install = data.install as Record<string, unknown> | undefined;
  const existing = install?.minimumReleaseAge as number | undefined;
  if (existing !== undefined && existing >= targetSeconds) return false;

  const setting = `minimumReleaseAge = ${targetSeconds}  # ${minAgeDays} days, in seconds`;
  const lines = content.split("\n");
  let modified: string;

  if (existing !== undefined) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith("minimumReleaseAge"));
    if (idx === -1) return false;
    lines[idx] = setting;
    modified = lines.join("\n");
  } else if (lines.some((l) => l.trim() === "[install]")) {
    const idx = lines.findIndex((l) => l.trim() === "[install]");
    lines.splice(idx + 1, 0, setting);
    modified = lines.join("\n");
  } else {
    modified = content.trimEnd() + "\n[install]\n" + setting + "\n";
  }

  return showDiff(file, content, modified);
}

/**
 * Suggest npm min-release-age in .npmrc.
 * Requires npm >= 11.10.
 */
async function suggestNpmAge(minAgeDays: number): Promise<boolean> {
  const ver = await getToolVersion("npm");
  if (ver && !versionAtLeast(ver, "11.10")) {
    core.info(`npm ${ver} does not support min-release-age (requires >= 11.10)`);
    return false;
  }
  const file = ".npmrc";
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    content = "";
  }

  // npm min-release-age unit is days
  const lines = content.split("\n");
  const existingIdx = lines.findIndex((l) => l.trimStart().startsWith("min-release-age"));
  if (existingIdx !== -1) {
    const existingVal = parseInt(lines[existingIdx].split("=")[1]?.trim() ?? "0", 10);
    if (existingVal >= minAgeDays) return false;
    lines[existingIdx] = `min-release-age=${minAgeDays}`;
  } else {
    lines.push(`min-release-age=${minAgeDays}`);
  }

  const modified = lines.join("\n");
  if (content === "") {
    // File didn't exist — write it, diff, then remove
    try {
      await fs.writeFile(file, modified, "utf8");
      await exec.exec("git", ["diff", "-u", "--color", "--no-index", "/dev/null", file], { silent: false, ignoreReturnCode: true });
      return true;
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  }

  return showDiff(file, content, modified);
}

/**
 * Suggest per-package age exclusions for uv.
 * Adds `exclude-newer-package` entries to the workspace root config
 * (uv.toml or pyproject.toml [tool.uv]).
 */
async function suggestUvPackageExclusions(
  failedPkgs: string[],
  workspaceDirs: Set<string>,
): Promise<void> {
  if (failedPkgs.length === 0) return;

  for (const dir of workspaceDirs) {
    const cfg = await resolveUvConfig(dir);
    if (!cfg) continue;

    const { file, content, isUvToml } = cfg;
    const lines = content.split("\n");
    const newEntries = failedPkgs.map((pkg) => `"${pkg}" = false`).join(", ");
    const setting = `exclude-newer-package = { ${newEntries} }`;

    // Check if exclude-newer-package already exists
    const existingIdx = lines.findIndex((l) => l.trimStart().startsWith("exclude-newer-package"));
    if (existingIdx !== -1) continue;

    // Insert after exclude-newer line, or after [tool.uv] header (pyproject), or at top (uv.toml)
    const enIdx = lines.findIndex((l) => {
      const t = l.trimStart();
      return t.startsWith("exclude-newer") && !t.startsWith("exclude-newer-package");
    });
    let insertIdx: number;
    if (enIdx !== -1) {
      insertIdx = enIdx + 1;
    } else if (!isUvToml) {
      let uvIdx = lines.findIndex((l) => l.trim() === "[tool.uv]");
      if (uvIdx === -1) {
        // Add [tool.uv] section at the end
        lines.push("", "[tool.uv]");
        uvIdx = lines.length - 1;
      }
      insertIdx = uvIdx + 1;
    } else {
      // uv.toml — insert after comments
      insertIdx = 0;
      while (insertIdx < lines.length && (lines[insertIdx].startsWith("#") || lines[insertIdx].trim() === "")) {
        insertIdx++;
      }
    }

    lines.splice(insertIdx, 0, setting);
    await showDiff(file, content, lines.join("\n"));
  }
}

/**
 * Suggest per-package exclusions for pnpm in pnpm-workspace.yaml.
 */
async function suggestPnpmPackageExclusions(failedPkgs: string[]): Promise<void> {
  if (failedPkgs.length === 0) return;
  const file = "pnpm-workspace.yaml";
  let content: string;
  try { content = await fs.readFile(file, "utf8"); } catch { return; }
  if (content.includes("minimumReleaseAgeExclude")) return;

  const entries = failedPkgs.map((pkg) => `  - "${pkg}"`).join("\n");
  const modified = content.trimEnd() + "\nminimumReleaseAgeExclude:\n" + entries + "\n";
  await showDiff(file, content, modified);
}

/**
 * Suggest per-package exclusions for yarn in .yarnrc.yml.
 * Uses npmPreapprovedPackages which exempts from all package gates including npmMinimalAgeGate.
 */
async function suggestYarnPackageExclusions(failedPkgs: string[]): Promise<void> {
  if (failedPkgs.length === 0) return;
  const file = ".yarnrc.yml";
  let content: string;
  try { content = await fs.readFile(file, "utf8"); } catch { return; }
  if (content.includes("npmPreapprovedPackages")) return;

  const entries = failedPkgs.map((pkg) => `  - "${pkg}"`).join("\n");
  const modified = content.trimEnd() + "\nnpmPreapprovedPackages:\n" + entries + "\n";
  await showDiff(file, content, modified);
}

/**
 * Suggest per-package exclusions for bun in bunfig.toml.
 */
async function suggestBunPackageExclusions(failedPkgs: string[]): Promise<void> {
  if (failedPkgs.length === 0) return;
  const file = "bunfig.toml";
  let content: string;
  try { content = await fs.readFile(file, "utf8"); } catch { return; }
  if (content.includes("minimumReleaseAgeExcludes")) return;

  const entries = failedPkgs.map((pkg) => `"${pkg}"`).join(", ");
  const lines = content.split("\n");
  const installIdx = lines.findIndex((l) => l.trim() === "[install]");
  if (installIdx !== -1) {
    lines.splice(installIdx + 1, 0, `minimumReleaseAgeExcludes = [${entries}]`);
  } else {
    lines.push("[install]", `minimumReleaseAgeExcludes = [${entries}]`);
  }
  await showDiff(file, content, lines.join("\n"));
}

/**
 * Find the insertion point in the workflow file for age-overrides/license-overrides.
 * Looks for `uses: ...lisan-al-gaib...` then finds the end of its `with:` block.
 */
function findActionInsertIdx(allLines: string[]): number {
  const actionPattern = /uses:.*lisan-al-gaib/;
  const actionLineIdx = allLines.findIndex((l) => actionPattern.test(l));
  if (actionLineIdx === -1) return -1;

  let insertIdx = allLines.length;
  let inWith = false;
  for (let i = actionLineIdx + 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (/^\s*with:/.test(line)) {
      inWith = true;
      continue;
    }
    if (inWith && line.trim() !== "") {
      const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (lineIndent < 10) {
        insertIdx = i;
        break;
      }
    }
  }
  return insertIdx;
}

/**
 * Suggest adding age-overrides to the workflow file for failed/warned packages.
 */
async function suggestAgeOverrides(results: CheckResult[]): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) return;

  // Collect only failed packages (not warn — those comply with min-age-days)
  const overrides = new Map<string, Set<string>>();
  for (const r of results) {
    if (r.status !== "fail") continue;
    const set = overrides.get(r.dep.ecosystem) ?? new Set();
    set.add(r.dep.name);
    overrides.set(r.dep.ecosystem, set);
  }
  if (overrides.size === 0) return;

  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  if (!workflowRef) return;
  let workflowFile: string | null = null;
  try {
    const { owner, repo } = github.context.repo;
    const prefix = `${owner}/${repo}/`;
    if (workflowRef.startsWith(prefix)) {
      const rest = workflowRef.slice(prefix.length);
      const atIdx = rest.lastIndexOf("@");
      if (atIdx !== -1) workflowFile = rest.slice(0, atIdx);
    }
  } catch { /* not in GH */ }
  if (!workflowFile) return;

  let original: string;
  try {
    original = await fs.readFile(workflowFile, "utf8");
  } catch {
    return;
  }

  const allLines = original.split("\n");
  const indent = "            "; // 12 spaces

  if (original.includes("age-overrides:")) {
    // Find the age-overrides block and append new entries
    const aoIdx = allLines.findIndex((l) => /^\s*age-overrides:/.test(l));
    if (aoIdx === -1) return;

    // Find the end of the age-overrides YAML literal block
    // It's a `|` block — find where indentation drops back
    const aoIndent = allLines[aoIdx].match(/^(\s*)/)?.[1]?.length ?? 0;
    let endIdx = aoIdx + 1;
    while (endIdx < allLines.length) {
      const line = allLines[endIdx];
      if (line.trim() === "") { endIdx++; continue; }
      const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (lineIndent <= aoIndent) break;
      endIdx++;
    }

    // Parse existing entries to avoid duplicates
    const existingContent = allLines.slice(aoIdx + 1, endIdx).join("\n");
    const newLines: string[] = [];
    for (const [eco, pkgs] of overrides) {
      const newPkgs = [...pkgs].filter((name) => !existingContent.includes(name));
      if (newPkgs.length === 0) continue;
      if (!existingContent.includes(`${eco}:`)) {
        newLines.push(`${indent}${eco}:`);
      }
      for (const name of newPkgs) {
        newLines.push(`${indent}  - ${yamlQuote(name)}`);
      }
    }
    if (newLines.length === 0) return;

    // Insert new entries at the end of the block, before existing ecosystem sections
    // or at the end of the block content
    const modified = [...allLines];
    modified.splice(endIdx, 0, ...newLines);
    await showGroupDiff(workflowFile, original, modified.join("\n"), "Suggested: add entries to age-overrides");
  } else {
    const insertIdx = findActionInsertIdx(allLines);
    if (insertIdx === -1) return;

    const blockLines: string[] = [`${indent.slice(2)}age-overrides: |`];
    for (const [eco, pkgs] of overrides) {
      blockLines.push(`${indent}${eco}:`);
      for (const name of pkgs) {
        blockLines.push(`${indent}  - ${yamlQuote(name)}`);
      }
    }
    allLines.splice(insertIdx, 0, blockLines.join("\n"));
    await showGroupDiff(workflowFile, original, allLines.join("\n"), "Suggested: add age-overrides to your workflow");
  }
}

/**
 * Detect which lockfiles are present and suggest the appropriate
 * package-manager-level age gate setting as a colored git diff.
 */
async function showAgeGateDiffs(
  results: CheckResult[],
  ecosystems: Set<string>,
  minAgeDays: number,
): Promise<void> {
  // Collect unique workspace root dirs from python lockfile paths (uv.lock dir = workspace root)
  const pythonWorkspaceDirs = new Set<string>();
  for (const r of results) {
    if (r.dep.ecosystem === "python") {
      pythonWorkspaceDirs.add(path.dirname(r.dep.file));
    }
  }

  // Section 1: Age gate number settings (exclude-newer, minimumReleaseAge, etc.)
  const hasPythonDirs = ecosystems.has("python") && pythonWorkspaceDirs.size > 0;
  const npmLockfiles = ecosystems.has("npm")
    ? new Set(results.filter((r) => r.dep.ecosystem === "npm").map((r) => path.basename(r.dep.file)))
    : new Set<string>();
  const hasNpmLockfiles = npmLockfiles.size > 0;

  if (hasPythonDirs || hasNpmLockfiles) {
    core.startGroup("Suggested: add package manager age gate settings");

    if (hasPythonDirs) {
      for (const dir of pythonWorkspaceDirs) {
        await suggestUvExcludeNewer(dir, minAgeDays);
      }
    }

    if (hasNpmLockfiles) {
      if (npmLockfiles.has("package-lock.json")) await suggestNpmAge(minAgeDays);
      if (npmLockfiles.has("pnpm-lock.yaml")) await suggestPnpmAge(minAgeDays);
      if (npmLockfiles.has("yarn.lock")) await suggestYarnAge(minAgeDays);
      if (npmLockfiles.has("bun.lock") || npmLockfiles.has("bun.lockb")) await suggestBunAge(minAgeDays);
    }

    core.endGroup();
  }

  // Section 2: Per-package exclusions (only for packages that FAIL, not warn)
  // Group failed packages by (ecosystem, workspace dir), deduplicated
  const failedPython = new Map<string, Set<string>>(); // dir → set of pkg names
  const failedNpmNames = new Set<string>();
  for (const r of results) {
    if (r.status !== "fail") continue;
    if (r.dep.ecosystem === "python") {
      const dir = path.dirname(r.dep.file);
      const set = failedPython.get(dir) ?? new Set();
      set.add(r.dep.name);
      failedPython.set(dir, set);
    } else if (r.dep.ecosystem === "npm") {
      failedNpmNames.add(r.dep.name);
    }
  }

  let shownExclusions = false;
  const startExclGroup = () => {
    if (!shownExclusions) { core.startGroup("Suggested: add per-package age gate exclusions"); shownExclusions = true; }
  };

  if (ecosystems.has("python")) {
    for (const [dir, pkgs] of failedPython) {
      startExclGroup();
      await suggestUvPackageExclusions([...pkgs], new Set([dir]));
    }
  }

  if (ecosystems.has("npm") && failedNpmNames.size > 0) {
    const lockfiles = new Set(results.map((r) => path.basename(r.dep.file)));
    const failedNpm = [...failedNpmNames];
    if (lockfiles.has("pnpm-lock.yaml")) { startExclGroup(); await suggestPnpmPackageExclusions(failedNpm); }
    if (lockfiles.has("yarn.lock")) { startExclGroup(); await suggestYarnPackageExclusions(failedNpm); }
    if (lockfiles.has("bun.lock") || lockfiles.has("bun.lockb")) { startExclGroup(); await suggestBunPackageExclusions(failedNpm); }
  }

  if (shownExclusions) core.endGroup();
}

export async function emitAnnotations(
  results: CheckResult[],
  ecosystems: string[],
  minAgeDays: number,
): Promise<void> {
  for (const { dep, ageDays, status } of results) {
    if (status === "fail") {
      core.error(
        `${dep.name}@${dep.version} published ${ageDays}d ago, minimum is ${minAgeDays}d`,
        { file: dep.file },
      );
    } else if (status === "warn") {
      core.warning(
        `${dep.name}@${dep.version} published ${ageDays}d ago`,
        { file: dep.file },
      );
    }
  }

  await showAgeGateDiffs(results, new Set(ecosystems), minAgeDays);
  await suggestAgeOverrides(results);
}

const STATUS_ORDER: Record<DepStatus, number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
};

/**
 * Compare two version strings with semver awareness.
 * Falls back to lexicographic comparison for non-semver versions.
 */
function compareVersions(a: string, b: string): number {
  const sa = semver.coerce(a);
  const sb = semver.coerce(b);
  if (sa && sb) return semver.compare(sa, sb);
  return a.localeCompare(b);
}

/**
 * Sort age results: fail/warn by increasing age then (ecosystem, name, version);
 * unknown/pass by (ecosystem, name, version) only.
 */
export function sortedByStatus(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => {
    // Primary: status order
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;

    // For fail/warn: sort by increasing age first
    if (a.status === "fail" || a.status === "warn") {
      const ageA = a.ageDays ?? Infinity;
      const ageB = b.ageDays ?? Infinity;
      if (ageA !== ageB) return ageA - ageB;
    }

    // Then ecosystem, name, version
    const ecoDiff = a.dep.ecosystem.localeCompare(b.dep.ecosystem);
    if (ecoDiff !== 0) return ecoDiff;
    const nameDiff = a.dep.name.localeCompare(b.dep.name);
    if (nameDiff !== 0) return nameDiff;
    return compareVersions(a.dep.version, b.dep.version);
  });
}

const LICENSE_STATUS_ORDER = {
  incompatible: 0,  // fail
  unknown: 1,       // unknown
  compatible: 2,    // pass
};

function licenseStatusKey(lr: LicenseResult): number {
  if (lr.compatible === false) return LICENSE_STATUS_ORDER.incompatible;
  if (lr.compatible === null) return LICENSE_STATUS_ORDER.unknown;
  return LICENSE_STATUS_ORDER.compatible;
}

/**
 * Sort license results: incompatible first, then unknown, then compatible.
 * Within each group, sort by (ecosystem, license, name, version).
 */
function sortedLicenseResults(results: LicenseResult[]): LicenseResult[] {
  return [...results].sort((a, b) => {
    const statusDiff = licenseStatusKey(a) - licenseStatusKey(b);
    if (statusDiff !== 0) return statusDiff;

    const ecoDiff = a.ecosystem.localeCompare(b.ecosystem);
    if (ecoDiff !== 0) return ecoDiff;
    const licA = a.spdx ?? a.license ?? "";
    const licB = b.spdx ?? b.license ?? "";
    const licDiff = licA.localeCompare(licB);
    if (licDiff !== 0) return licDiff;
    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff !== 0) return nameDiff;
    return compareVersions(a.version, b.version);
  });
}

export async function writeSummary(
  results: CheckResult[],
  minAgeDays: number,
  warnAgeDays: number,
  licenseResults: LicenseResult[] = [],
): Promise<void> {
  if (results.length === 0 && licenseResults.length === 0) {
    core.summary.addRaw("No dependency changes detected.");
    const branding = getBranding();
    if (branding) core.summary.addRaw(branding);
    await core.summary.write();
    return;
  }

  const statusIcon: Record<DepStatus, string> = {
    pass: "✅",
    warn: "⚠️",
    fail: "❌",
    unknown: "❓",
  };

  core.summary.addHeading("Lisan al-Gaib", 2);
  core.summary.addRaw(
    `Minimum age: *${minAgeDays}d* | Warning threshold: *${warnAgeDays}d*\n\n`,
  );

  core.summary.addTable([
    [
      { data: "Ecosystem", header: true },
      { data: "Package", header: true },
      { data: "Version", header: true },
      { data: "Age (days)", header: true },
      { data: "Status", header: true },
    ],
    ...sortedByStatus(results).map((r) => [
      r.dep.ecosystem,
      r.dep.name,
      r.dep.version,
      r.ageDays !== null ? String(r.ageDays) : "?",
      `${statusIcon[r.status]} ${r.status.toUpperCase()}`,
    ]),
  ]);

  // License compliance table
  if (licenseResults.length > 0) {
    core.summary.addHeading("License Compliance", 2);
    core.summary.addTable([
      [
        { data: "Ecosystem", header: true },
        { data: "Package", header: true },
        { data: "Version", header: true },
        { data: "License", header: true },
        { data: "Status", header: true },
      ],
      ...sortedLicenseResults(licenseResults).map((lr) => [
        lr.ecosystem,
        lr.name,
        lr.version,
        lr.spdx ?? lr.license ?? "?",
        lr.compatible === true
          ? "✅ OK"
          : lr.compatible === false
            ? "❌ INCOMPATIBLE"
            : "❓ UNKNOWN",
      ]),
    ]);
  }

  const branding = getBranding();
  if (branding) core.summary.addRaw(branding);

  await core.summary.write();
}

export function reportTotals(results: CheckResult[]): {
  checked: number;
  failures: number;
  warnings: number;
} {
  const checked = results.filter((r) => r.status !== "unknown").length;
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return { checked, failures, warnings };
}
