import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as path from "node:path";

// DiffSource: an alternative diff backend for when local git history is unavailable.
// The base commit is captured at construction time, so methods don't take baseRef.
export interface DiffSource {
  diff(file: string): Promise<string>;
  diffNameOnly(): Promise<string[]>;
  diffFiltered(filter: string): Promise<string[]>;
  showFile(file: string): Promise<string | null>;
}

let activeSource: DiffSource | null = null;

export function setDiffSource(s: DiffSource | null): void {
  activeSource = s;
}

export async function resolveFiles(input: string): Promise<string[]> {
  const entries = input.split("\n").map((s) => s.trim()).filter(Boolean);
  const files = new Set<string>();
  const cwd = process.cwd();

  for (const entry of entries) {
    const globber = await glob.create(entry, { followSymbolicLinks: false });
    const matched = await globber.glob();
    if (matched.length > 0) {
      // Normalize to relative paths so they match git diff output
      for (const f of matched) files.add(path.relative(cwd, f));
    } else if (!/[*?{[]/.test(entry)) {
      // Literal path that didn't match — include anyway (may not exist yet)
      files.add(entry);
    }
  }

  return [...files];
}

async function gitDiffImpl(baseRef: string, file: string): Promise<string> {
  let output = "";
  await exec.exec("git", ["diff", baseRef, "--", file], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return output;
}

async function gitDiffFilteredImpl(baseRef: string, filter: string): Promise<string[]> {
  let output = "";
  await exec.exec("git", ["diff", "--name-only", `--diff-filter=${filter}`, baseRef], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return output.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function gitDiffNameOnlyImpl(baseRef: string): Promise<string[]> {
  let output = "";
  await exec.exec("git", ["diff", "--name-only", baseRef], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return output.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function gitShowFileImpl(ref: string, file: string): Promise<string | null> {
  let output = "";
  const exitCode = await exec.exec("git", ["show", `${ref}:${file}`], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return exitCode === 0 ? output : null;
}

export async function gitDiff(baseRef: string, file: string): Promise<string> {
  if (activeSource) return activeSource.diff(file);
  return gitDiffImpl(baseRef, file);
}

export async function gitDiffFiltered(baseRef: string, filter: string): Promise<string[]> {
  if (activeSource) return activeSource.diffFiltered(filter);
  return gitDiffFilteredImpl(baseRef, filter);
}

export async function gitDiffNameOnly(baseRef: string): Promise<string[]> {
  if (activeSource) return activeSource.diffNameOnly();
  return gitDiffNameOnlyImpl(baseRef);
}

export async function gitShowFile(ref: string, file: string): Promise<string | null> {
  if (activeSource) return activeSource.showFile(file);
  return gitShowFileImpl(ref, file);
}
