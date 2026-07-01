#!/usr/bin/env node

import cac from "cac";
import * as clack from "@clack/prompts";
import { run, SUPPORTED_ECOSYSTEMS, UserCancelledError } from "./run.js";
import type { RunOpts, RunResult } from "./run.js";
import { DEFAULT_MIN_AGE_DAYS, DEFAULT_REGISTRIES, trimSlash, type RegistryUrls } from "../inputs.js";
import { CLI_VERSION } from "./version.js";
import { installActionsCommandFilter } from "../actions-stdout.js";

function fail(msg: string, isJson: boolean): never {
  if (!isJson) clack.cancel(msg);
  else console.error(msg);
  process.exit(1);
}

/** Thrown by {@link parseAndValidate} when a CLI argument is invalid. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Parsed and validated CLI arguments ready to pass to {@link run}. */
export interface ParseResult {
  runOpts: RunOpts;
  isJson: boolean;
  isDryRun: boolean;
  /** True when --json and --yes were both given; the caller should emit a warning. */
  jsonYesWarning: boolean;
}

/**
 * Determine the process exit code from a RunResult.
 * - Exit 1 when any update failed to apply.
 * - In report-only modes (--dry-run, --json), `noEdits` only describes what a real
 *   apply run *would* skip — no files were ever written or attempted, so a benign
 *   no-op (e.g. a multi-line FROM, a template-incompatible version constant) must
 *   not fail the preview. Only `failed` (a hard error discovered while building the
 *   report) can exit non-zero in this mode.
 * - Otherwise (an actual apply run) under --yes: exit 1 when any selected update
 *   produced no file edits — a non-interactive run has no human to notice the
 *   warning above, so a partial (or total) no-op must be flagged via exit code.
 * - Otherwise (an actual apply run, interactive): a benign no-op is not an error —
 *   the user positively selected exactly the candidates that couldn't produce an
 *   edit, saw the warning printed above, and made an informed choice. Exit 0.
 * - Exit 0 otherwise (including when the user intentionally selects nothing).
 */
export function computeExitCode(result: RunResult, yes: boolean, isDryRun: boolean): number {
  if (result.failed.length > 0) return 1;
  if (isDryRun) return 0;
  if (yes && result.noEdits.length > 0) return 1;
  return 0;
}

/**
 * Validate raw CLI arguments and build {@link RunOpts}.
 * Throws {@link ValidationError} on any invalid input so callers can unit-test
 * the validation logic without spawning a subprocess.
 */
export function parseAndValidate(rawEcosystems: string | string[], opts: Record<string, unknown>): ParseResult {
  const isJson = Boolean(opts["json"]);
  const isDryRun = Boolean(opts["dryRun"]) || isJson;
  const jsonYesWarning = isJson && Boolean(opts["yes"]);

  // Normalise: cac passes a string when one arg is given, an array for many.
  // Also support comma-separated lists like "actions,docker" as a single token.
  const ecosystems = (Array.isArray(rawEcosystems) ? rawEcosystems : [rawEcosystems])
    .flatMap((e) => e.split(","))
    .map((e) => e.trim())
    .filter(Boolean);
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueEcosystems = ecosystems.filter((e) => (seen.has(e) ? false : (seen.add(e), true)));

  const unknown = uniqueEcosystems.filter((e) => !SUPPORTED_ECOSYSTEMS.has(e as never));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown ecosystem(s): ${unknown.join(", ")}. Supported: ${[...SUPPORTED_ECOSYSTEMS].join(", ")}`);
  }

  // Build exclude regexes
  const excludeRaw = opts["exclude"];
  const excludePatterns: string[] = Array.isArray(excludeRaw)
    ? excludeRaw.map(String)
    : excludeRaw ? [String(excludeRaw)] : [];
  const exclude: RegExp[] = [];
  for (const p of excludePatterns) {
    try {
      exclude.push(new RegExp(p));
    } catch {
      throw new ValidationError(`Invalid --exclude pattern: ${p}`);
    }
  }

  const allowDowngradeRaw = String(opts["allowDowngrade"] ?? "no");
  if (!["no", "allow", "only"].includes(allowDowngradeRaw)) {
    throw new ValidationError(`Invalid --allow-downgrade value: ${allowDowngradeRaw}. Must be one of: no, allow, only`);
  }
  const allowDowngrade = allowDowngradeRaw as "no" | "allow" | "only";

  const licensePolicyRaw = String(opts["licensePolicy"] ?? "block");
  if (!["block", "warn", "off"].includes(licensePolicyRaw)) {
    throw new ValidationError(`Invalid --license-policy value: ${licensePolicyRaw}. Must be one of: block, warn, off`);
  }
  const licensePolicy = licensePolicyRaw as "block" | "warn" | "off";

  const registries: RegistryUrls = {
    npm: trimSlash(String(opts["npmRegistryUrl"] ?? DEFAULT_REGISTRIES.npm)),
    pypi: trimSlash(String(opts["pypiRegistryUrl"] ?? DEFAULT_REGISTRIES.pypi)),
    crates: trimSlash(String(opts["cratesRegistryUrl"] ?? DEFAULT_REGISTRIES.crates)),
    maven: trimSlash(String(opts["mavenRegistryUrl"] ?? DEFAULT_REGISTRIES.maven)),
  };

  // Validate --min-age: must be a non-negative safe integer when explicitly provided.
  const minAgeRaw = opts["minAge"] !== undefined ? String(opts["minAge"]).trim() : undefined;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  if (minAgeRaw !== undefined) {
    if (!/^\d+$/.test(minAgeRaw)) {
      throw new ValidationError(`Invalid --min-age value: ${JSON.stringify(opts["minAge"])}. Must be a non-negative integer number of days (e.g. 14).`);
    }
    const parsed = Number(minAgeRaw);
    // Reject huge values that lose precision as JS floats (Number.MAX_SAFE_INTEGER ≈ 9e15 days).
    if (!Number.isSafeInteger(parsed)) {
      throw new ValidationError(`Invalid --min-age value: ${minAgeRaw}. Value exceeds Number.MAX_SAFE_INTEGER.`);
    }
    minAgeDays = parsed;
  }

  const modeRaw = String(opts["mode"] ?? "major");
  if (!["major", "minor", "patch"].includes(modeRaw)) {
    throw new ValidationError(`Invalid --mode value: ${modeRaw}. Must be one of: major, minor, patch`);
  }
  const mode = modeRaw as "major" | "minor" | "patch";

  const styleRaw = String(opts["style"] ?? "sha");
  if (!["sha", "preserve"].includes(styleRaw)) {
    throw new ValidationError(`Invalid --style value: ${styleRaw}. Must be one of: sha, preserve`);
  }
  const style = styleRaw as "sha" | "preserve";

  const runOpts: RunOpts = {
    ecosystems: uniqueEcosystems,
    workflowFiles: opts["workflowFiles"] as string | undefined,
    dockerfiles: opts["dockerfiles"] as string | undefined,
    kubernetesFiles: opts["kubernetesFiles"] as string | undefined,
    moduleBazel: (opts["moduleBazel"] as string | undefined) ?? "MODULE.bazel",
    mode,
    style,
    minAgeDays,
    yes: Boolean(opts["yes"]),
    dryRun: isDryRun,
    json: isJson,
    exclude,
    allowDowngrade,
    licensePolicy,
    token: process.env.GITHUB_TOKEN ?? "",
    registries,
    bcrUrl: trimSlash(String(opts["bcrUrl"] ?? DEFAULT_REGISTRIES.bcrUrl)),
    dockerhubMirror: opts["dockerhubMirror"] as string | undefined,
    pinUnpinned: opts["pinUnpinned"] !== false,
  };

  return { runOpts, isJson, isDryRun, jsonYesWarning };
}

const cli = cac("update");

cli
  .command("<...ecosystems>", "Update dependency versions for the given ecosystem(s)")
  .option("--mode <mode>", "Update mode: major, minor, or patch (default: major)")
  .option("-y, --yes", "Apply all updates without prompting")
  .option("--dry-run", "Report available updates without writing files")
  .option("--json", "Output results as JSON (implies --dry-run)")
  .option("--style <style>", "How to write updated refs: sha or preserve (default: sha)")
  .option("--min-age <days>", `Minimum package age in days (default: ${DEFAULT_MIN_AGE_DAYS})`)
  .option("--allow-downgrade <policy>", "Downgrade policy when current version is too young: no, allow, or only (default: no)")
  .option("--license-policy <policy>", "How to handle a suggested version with a more-restrictive license: block, warn, or off (default: block)")
  .option("--exclude <pattern>", "Exclude packages whose name matches this unanchored regex pattern (repeatable; '.' matches any char — use '\\\\.' for a literal dot)")
  .option("--workflow-files <glob>", "Glob pattern for workflow files (actions ecosystem)")
  .option("--dockerfiles <glob>", "Glob pattern for Dockerfiles (docker ecosystem)")
  .option("--kubernetes-files <glob>", "Glob pattern for k8s manifests (kubernetes ecosystem)")
  .option("--module-bazel <path>", "Path to MODULE.bazel (rust/java/bazel ecosystems, default: MODULE.bazel)")
  .option("--bcr-url <url>", "Bazel Central Registry URL (default: https://bcr.bazel.build)")
  .option("--npm-registry-url <url>", "npm registry URL")
  .option("--pypi-registry-url <url>", "PyPI registry URL")
  .option("--crates-registry-url <url>", "crates.io registry URL")
  .option("--maven-registry-url <url>", "Maven registry URL")
  .option("--dockerhub-mirror <host>", "Docker Hub mirror host tried as fallback when Docker Hub rate-limits digest resolution (e.g. mirror.gcr.io)")
  .option("--pin-unpinned", "Pin previously-unpinned docker/k8s images to their current digest even when the age gate fails (too young or publish date unconfirmable). A warning is emitted per image. Default: true. Pass --no-pin-unpinned to skip these images instead.", { default: true })
  .action(async (rawEcosystems: string | string[], opts: Record<string, unknown>) => {
    const isJson = Boolean(opts["json"]);

    let parsed: ParseResult;
    try {
      parsed = parseAndValidate(rawEcosystems, opts);
    } catch (err) {
      return fail(err instanceof ValidationError ? err.message : String(err), isJson);
    }
    const { runOpts, isDryRun, jsonYesWarning } = parsed;

    if (jsonYesWarning) {
      console.error("[lisan] Warning: --json implies --dry-run; --yes is ignored (no files will be written).");
    }

    if (!isJson) {
      clack.intro("lisan-al-gaib updater");
    }

    const needsGitHub = runOpts.ecosystems.some((e) =>
      ["bazel", "actions"].includes(e),
    );
    if (needsGitHub && !runOpts.token && !isJson) {
      clack.log.warn(
        "GITHUB_TOKEN is not set — GitHub API calls are limited to 60 requests/hour.\n" +
          "Publish-date lookups for bazel/actions may report as unknown.\n" +
          "Set GITHUB_TOKEN to raise the limit to 5000 requests/hour.",
      );
    }

    try {
      const result = await run(runOpts);

      if (!isJson) {
        if (isDryRun) {
          clack.note(
            result.candidates.length === 0
              ? "No updates available."
              : result.candidates
                  .map(
                    (c) =>
                      `${c.dep.name}: ${c.dep.current} -> ${c.latest}${c.breaking ? " (breaking)" : ""}${c.direction === "downgrade" ? " (downgrade)" : ""}`,
                  )
                  .join("\n"),
            isDryRun ? "Available updates (dry-run)" : "Applied updates",
          );
        }
        if (result.failed.length > 0) {
          clack.log.warn(
            `${result.failed.length} update(s) could not be applied. ` +
            "Run with --dry-run to inspect, or check the output above for details.",
          );
        }
        if (result.noEdits.length > 0) {
          // noEdits are benign skips (multi-line FROM, template-incompatible version constant,
          // reconcile-dropped shared constant, unresolvable digest). The ecosystem module
          // already warned for each. Surface the count here as a summary for visibility.
          // Under --yes, this is treated as a failure (see computeExitCode).
          clack.log.warn(
            `${result.noEdits.length} update(s) were skipped: no file edits could be produced ` +
            `(multi-line FROM instruction, template-incompatible version constant, ` +
            `unresolvable digest, or reconcile-dropped shared constant): ` +
            result.noEdits.map((c) => c.dep.name).join(", ") +
            (runOpts.yes ? " — under --yes, this is treated as a failure." : ""),
          );
        }
        clack.outro(
          isDryRun
            ? "Dry run complete — no files written."
            : result.applied.length > 0
              ? `Updated ${result.applied.length} package(s).`
              : "No updates applied.",
        );
      }
      const exitCode = computeExitCode(result, runOpts.yes, isDryRun);
      if (exitCode !== 0) process.exit(exitCode);
    } catch (err) {
      if (err instanceof UserCancelledError) {
        process.exit(0);
      }
      if (!isJson) {
        clack.cancel(err instanceof Error ? err.message : String(err));
      } else {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }
  });

cli.help();
cli.version(CLI_VERSION);
// Guard: do not invoke argument parsing, nor patch process.stdout.write, when this
// module is imported from tests (vitest sets VITEST=true) rather than run as a CLI.
// installActionsCommandFilter intercepts @actions/core's stdout ::commands
// (core.warning/core.info/etc. fire unconditionally from deep inside run(), not just
// under --json) and renders them on stderr instead, so `--json`'s stdout stays pure
// JSON regardless of what warnings fire during the run — see run.ts's JSON output
// step, which writes via writeRawStdout() to bypass this filter for the payload itself.
if (!process.env["VITEST"]) {
  installActionsCommandFilter();
  cli.parse();
}
