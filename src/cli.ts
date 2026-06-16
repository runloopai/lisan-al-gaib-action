#!/usr/bin/env node
/**
 * CLI entry point for running lisan-al-gaib locally.
 *
 * Usage:
 *   pnpm local [-- options]          # locally: runs tsc + node out/cli.js
 *   node out/cli.js [options]        # after `pnpm build`
 *   (verify runs as a GitHub Action via action.yml in CI)
 *
 * Modes:
 *   --base-ref <ref>    Compare HEAD against a specific ref (default: auto-detect remote default branch)
 *   --diff              Compare working tree (dirty changes) against HEAD
 *   --all               Check ALL dependencies, not just changed ones (uses empty tree as base)
 *
 * Options:
 *   --ecosystems <list> Comma-separated ecosystems (default: npm)
 *   --min-age-days <n>  Minimum age in days (default: 14)
 *   --warn-age-days <n> Warning threshold in days (default: 21)
 *   --module-bazel <p>  Path to MODULE.bazel (default: MODULE.bazel)
 */

import { execSync } from "node:child_process";
import { EMPTY_TREE } from "./base-ref.js";
import { installActionsCommandFilter } from "./actions-stdout.js";

function getRemoteDefaultBranch(): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // refs/remotes/origin/main → origin/main
    return ref.replace("refs/remotes/", "");
  } catch {
    return "origin/main";
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--diff") {
      args["diff"] = "true";
    } else if (arg === "--all") {
      args["all"] = "true";
    } else if (arg === "--") {
      continue;
    } else if (arg.startsWith("--") && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Determine base ref
  let baseRef: string;
  if (args["all"]) {
    // Empty tree SHA — diffs everything
    baseRef = EMPTY_TREE;
  } else if (args["diff"]) {
    baseRef = "HEAD";
  } else if (args["base-ref"]) {
    baseRef = args["base-ref"];
  } else {
    baseRef = getRemoteDefaultBranch();
  }

  // Set INPUT_ environment variables for @actions/core
  const inputs: Record<string, string> = {
    ecosystems: args["ecosystems"] ?? "npm",
    "min-age-days": args["min-age-days"] ?? "14",
    "warn-age-days": args["warn-age-days"] ?? "21",
    "base-ref": baseRef,
    "module-bazel": args["module-bazel"] ?? "MODULE.bazel",
    "node-lockfiles": args["node-lockfiles"] ?? "",
    "python-lockfiles": args["python-lockfiles"] ?? "",
    "workflow-files": args["workflow-files"] ?? "",
    "kubernetes-files": args["kubernetes-files"] ?? "",
    "dockerfiles": args["dockerfiles"] ?? "",
    "dockerhub-mirror": args["dockerhub-mirror"] ?? "",
    "github-token": args["github-token"] ?? process.env.GITHUB_TOKEN ?? "",
    "bcr-url": args["bcr-url"] ?? "https://bcr.bazel.build",
    "npm-registry-url": args["npm-registry-url"] ?? "https://registry.npmjs.org",
    "pypi-registry-url": args["pypi-registry-url"] ?? "https://pypi.org",
    "crates-registry-url": args["crates-registry-url"] ?? "https://crates.io",
    "maven-registry-url": args["maven-registry-url"] ?? "https://repo1.maven.org/maven2",
    "check-all-on-new-workflow": "false",
    "fetch-missing-history-retries": args["fetch-missing-history-retries"] ?? "10",
    "strict-third-party": args["strict-third-party"] ?? "false",
    "bypass-keyword": "",
    "target-licenses": args["target-licenses"] ?? "",
    "allowed-licenses": args["allowed-licenses"] ?? "auto",
    "age-overrides": args["age-overrides"] ?? "",
    "license-overrides": args["license-overrides"] ?? "",
    // Default false to match action.yml; avoids tarball-downloading path in local runs
    // that differs from what CI exercises. Use --license-heuristics to opt in.
    "license-heuristics": args["license-heuristics"] ?? "false",
  };

  for (const [key, value] of Object.entries(inputs)) {
    // @actions/core.getInput() looks up INPUT_{NAME} with spaces→underscores
    // but preserves dashes. Use the key as-is (uppercased) to match.
    process.env[`INPUT_${key.toUpperCase()}`] = value;
  }

  // Set a dummy GITHUB_STEP_SUMMARY so @actions/core doesn't crash
  if (!process.env.GITHUB_STEP_SUMMARY) {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "dep-age-"));
    const summaryPath = join(tmp, "summary.md");
    writeFileSync(summaryPath, "");
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
  }

  // Set dummy GITHUB_OUTPUT if not set
  if (!process.env.GITHUB_OUTPUT) {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "dep-age-out-"));
    const outPath = join(tmp, "output.txt");
    writeFileSync(outPath, "");
    process.env.GITHUB_OUTPUT = outPath;
  }

  // When running outside GitHub Actions, intercept stdout ::commands
  // and render them as colored output on stderr instead.
  installActionsCommandFilter();

  // Import and run the main action
  await import("./main.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
