import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { getInputs } from "./inputs.js";
import { resolveBaseRef, validateBaseRef, ensureBaseRefAvailable } from "./base-ref.js";
import { gitDiffFiltered } from "./diff.js";
import * as npm from "./ecosystems/npm.js";
import * as python from "./ecosystems/python.js";
import * as rust from "./ecosystems/rust.js";
import * as java from "./ecosystems/java.js";
import * as bazelModule from "./ecosystems/bazel-module.js";
import * as actions from "./ecosystems/actions.js";
import * as multitool from "./ecosystems/multitool.js";
import { bcrPublishDate, gitCommitDate, archiveDate } from "./registry.js";
import type { BazelOverride } from "./ecosystems/types.js";
import {
  determineStatus,
  emitAnnotations,
  writeSummary,
  reportTotals,
} from "./report.js";
import {
  getTargetLicenses,
  checkLicenses,
  emitLicenseAnnotations,
  fetchLicense,
} from "./license.js";
import type { ChangedDep, CheckResult } from "./ecosystems/types.js";

const DAY_MS = 86_400_000;

/**
 * Parse GITHUB_WORKFLOW_REF to extract the workflow file path.
 * Format: {owner}/{repo}/{path}@{ref}
 * We strip {owner}/{repo}/ prefix and @{ref} suffix.
 */
function getWorkflowFilePath(): string | null {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  if (!workflowRef) return null;

  const repo = github.context.repo;
  const prefix = `${repo.owner}/${repo.repo}/`;
  if (!workflowRef.startsWith(prefix)) return null;

  const rest = workflowRef.slice(prefix.length);
  const atIdx = rest.lastIndexOf("@");
  if (atIdx === -1) return null;

  return rest.slice(0, atIdx);
}

/**
 * Check if the workflow file that triggered this run was newly added.
 * If so, return an empty-tree ref to force checking all packages.
 */
async function resolveEffectiveBaseRef(
  baseRef: string,
  checkAllOnNewWorkflow: boolean,
): Promise<string> {
  if (!checkAllOnNewWorkflow) return baseRef;

  const workflowPath = getWorkflowFilePath();
  if (!workflowPath) return baseRef;

  core.info(`Workflow file: ${workflowPath}`);

  // Use --diff-filter=A to only match truly added files, not renames
  const addedFiles = await gitDiffFiltered(baseRef, "A");
  if (!addedFiles.includes(workflowPath)) return baseRef;

  core.info(
    `Workflow file ${workflowPath} is newly added — checking ALL packages`,
  );

  // Empty tree SHA — forces diffing everything
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

/**
 * Check whether the bypass keyword appears in:
 * 1. The PR body (on a line by itself, leading/trailing whitespace allowed)
 * 2. A PR label matching the keyword
 * 3. The HEAD commit message (for push/workflow_dispatch/etc.)
 */
async function checkBypass(keyword: string, token: string): Promise<boolean> {
  // 1. PR body
  const prBody =
    github.context.payload.pull_request?.body as string | undefined;
  if (prBody) {
    const lines = prBody.split("\n").map((l) => l.trim());
    if (lines.includes(keyword)) return true;
  }

  // 2. PR labels
  const labels = github.context.payload.pull_request?.labels as
    | Array<{ name: string }>
    | undefined;
  if (labels?.some((l) => l.name === keyword)) return true;

  // If not a PR, also try fetching labels via API (for push events on PRs)
  if (!labels && token) {
    try {
      const octokit = github.getOctokit(token);
      const { owner, repo } = github.context.repo;
      // Find PRs associated with the HEAD commit
      const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: github.context.sha,
      });
      for (const pr of prs) {
        if (pr.labels.some((l) => l.name === keyword)) return true;
        if (pr.body) {
          const lines = pr.body.split("\n").map((l: string) => l.trim());
          if (lines.includes(keyword)) return true;
        }
      }
    } catch {
      // API call failed, continue to commit message check
    }
  }

  // 3. HEAD commit message
  try {
    let msg = "";
    await exec.exec("git", ["log", "-1", "--format=%B"], {
      listeners: { stdout: (data) => (msg += data.toString()) },
      silent: true,
    });
    const lines = msg.split("\n").map((l) => l.trim());
    if (lines.includes(keyword)) return true;
  } catch {
    // git not available
  }

  return false;
}

async function lookupPublishDate(
  dep: ChangedDep,
  inputs: ReturnType<typeof getInputs>,
  javaRepoMap: Map<string, string[]>,
  bazelOverrides: Map<string, BazelOverride>,
): Promise<Date | null> {
  switch (dep.ecosystem) {
    case "npm":
      return npm.getPublishDate(dep.name, dep.version, inputs.registries);
    case "python":
      return python.getPublishDate(dep.name, dep.version, inputs.registries);
    case "rust":
      return rust.getPublishDate(dep.name, dep.version, inputs.registries);
    case "java":
      return java.getPublishDate(
        dep.name,
        dep.version,
        javaRepoMap.get(dep.name) ?? [],
        inputs.registries,
      );
    case "bazel": {
      const override = bazelOverrides.get(dep.name);
      if (override?.type === "git" && override.remote) {
        const ref = override.commit ?? override.tag ?? override.branch;
        if (ref) {
          return gitCommitDate(override.remote, ref, inputs.githubToken);
        }
      } else if (override?.type === "archive" && override.urls?.length) {
        const date = await archiveDate(override.urls[0]);
        if (date === null) {
          const msg = `${dep.name}: archive_override has no Last-Modified header (${override.urls[0]})`;
          if (inputs.strictThirdParty) {
            core.error(msg, { file: dep.file });
          } else {
            core.warning(msg, { file: dep.file });
          }
        }
        return date;
      } else {
        return bcrPublishDate(dep.name, dep.version, inputs.githubToken, inputs.bcrUrl);
      }
      return null;
    }
    case "actions": {
      const publishDate = await actions.getPublishDate(dep.name, dep.version, inputs.githubToken);
      const isSha = /^[0-9a-f]{40}$/.test(dep.version);
      if (publishDate === null && !isSha) {
        const actionOwner = dep.name.split("/")[0];
        let contextOwner = "";
        try { contextOwner = github.context.repo.owner; } catch { /* not in GH */ }
        if (actionOwner !== contextOwner) {
          const msg = `${dep.name}@${dep.version} appears to be a branch ref from a third-party owner`;
          if (inputs.strictThirdParty) {
            core.error(msg, { file: dep.file });
          } else {
            core.warning(msg, { file: dep.file });
          }
        }
      }
      return publishDate;
    }
    case "multitool": {
      const date = await multitool.getPublishDate(dep.version);
      if (date === null) {
        const msg = `${dep.name}: multitool binary has no Last-Modified header (${dep.version})`;
        if (inputs.strictThirdParty) {
          core.error(msg, { file: dep.file });
        } else {
          core.warning(msg, { file: dep.file });
        }
      }
      return date;
    }
    default:
      return null;
  }
}

async function run(): Promise<void> {
  const inputs = getInputs();
  const rawBaseRef = resolveBaseRef(inputs.baseRef);
  const validatedRef = await validateBaseRef(rawBaseRef);
  const diffableRef = await ensureBaseRefAvailable(validatedRef);
  const baseRef = await resolveEffectiveBaseRef(
    diffableRef,
    inputs.checkAllOnNewWorkflow,
  );

  core.info(
    `Dependency age check — min: ${inputs.minAgeDays}d, warn: ${inputs.warnAgeDays}d, base: ${baseRef}`,
  );

  const allResults: CheckResult[] = [];

  // Cache for publish date lookups: "ecosystem:name@version" → Date | null
  const publishDateCache = new Map<string, Date | null>();

  // Per-ecosystem metadata maps
  let javaRepoMap = new Map<string, string[]>();
  let bazelOverrides = new Map<string, BazelOverride>();

  for (const eco of inputs.ecosystems) {
    core.startGroup(`=== ${eco} ===`);

    let deps: ChangedDep[];

    switch (eco) {
      case "npm":
        deps = await npm.getChangedDeps(baseRef, inputs.nodeLockfiles);
        break;
      case "python":
        deps = await python.getChangedDeps(baseRef, inputs.pythonLockfiles);
        break;
      case "rust":
        deps = await rust.getChangedDeps(baseRef, inputs.moduleBazel);
        break;
      case "java": {
        const result = await java.getChangedDeps(baseRef, inputs.moduleBazel);
        deps = result.deps;
        javaRepoMap = result.repositories;
        break;
      }
      case "bazel": {
        const result = await bazelModule.getChangedDeps(
          baseRef,
          inputs.moduleBazel,
        );
        deps = result.deps;
        bazelOverrides = result.overrides;
        break;
      }
      case "actions":
        deps = await actions.getChangedDeps(baseRef, inputs.workflowFiles);
        break;
      case "multitool":
        deps = await multitool.getChangedDeps(
          baseRef,
          inputs.moduleBazel,
        );
        break;
      default:
        core.setFailed(`Unknown ecosystem: ${eco}`);
        return;
    }

    if (deps.length === 0) {
      core.info(`No new/changed packages in ${eco}`);
      core.endGroup();
      continue;
    }

    core.info(`Found ${deps.length} changed packages in ${eco}`);

    // Filter out age-overridden packages
    const filteredDeps = deps.filter((dep) => {
      if (inputs.ageOverrides.get(dep.ecosystem)?.has(dep.name)) {
        core.info(`Skipping age check for ${dep.name} (age-override)`);
        return false;
      }
      return true;
    });

    // Deduplicate by cache key, then fetch in parallel
    const uniqueDeps = new Map<string, ChangedDep>();
    for (const dep of filteredDeps) {
      const cacheKey = `${dep.ecosystem}:${dep.name}@${dep.version}`;
      if (!publishDateCache.has(cacheKey) && !uniqueDeps.has(cacheKey)) {
        uniqueDeps.set(cacheKey, dep);
      }
    }
    const entries = [...uniqueDeps.entries()];
    // Fetch in batches of 10 to avoid rate limiting
    for (let i = 0; i < entries.length; i += 10) {
      const batch = entries.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(([, dep]) => lookupPublishDate(dep, inputs, javaRepoMap, bazelOverrides)),
      );
      batch.forEach(([key], idx) => {
        const r = results[idx];
        if (r.status === "fulfilled") {
          publishDateCache.set(key, r.value);
        } else {
          core.warning(`Registry lookup failed for ${key}: ${r.reason}`);
          publishDateCache.set(key, null);
        }
      });
    }

    for (const dep of filteredDeps) {
      const cacheKey = `${dep.ecosystem}:${dep.name}@${dep.version}`;
      const publishDate = publishDateCache.get(cacheKey) ?? null;

      const ageDays =
        publishDate !== null
          ? Math.floor((Date.now() - publishDate.getTime()) / DAY_MS)
          : null;

      const status = determineStatus(
        ageDays,
        inputs.minAgeDays,
        inputs.warnAgeDays,
      );

      allResults.push({ dep, publishDate, ageDays, status });
    }

    core.endGroup();
  }

  // License compliance check
  const targetLicenses = await getTargetLicenses(inputs.allowedLicenses);
  let licenseViolations = 0;
  let licenseResults: Awaited<ReturnType<typeof checkLicenses>> = [];

  if (targetLicenses && targetLicenses.size > 0) {
    core.startGroup("=== license compliance ===");
    for (const [eco, licenses] of targetLicenses) {
      core.info(`Target licenses [${eco}]: ${licenses.join(", ")}`);
    }
    licenseResults = await checkLicenses(
      allResults,
      targetLicenses,
      inputs.registries,
      javaRepoMap,
      inputs.githubToken,
      inputs.bcrUrl,
      inputs.licenseOverrides,
      inputs.licenseHeuristics,
    );
    // When heuristics is off, still try to infer licenses for suggestion purposes
    let inferredLicenses: Map<string, string> | undefined;
    if (!inputs.licenseHeuristics) {
      inferredLicenses = new Map();
      const unknowns = licenseResults.filter((lr) => lr.compatible === null && lr.license === null);
      for (const lr of unknowns) {
        const dep = { ecosystem: lr.ecosystem, name: lr.name, version: lr.version };
        const inferred = await fetchLicense(dep, inputs.registries, javaRepoMap, inputs.githubToken, inputs.bcrUrl, true);
        if (inferred) {
          inferredLicenses.set(`${lr.ecosystem}:${lr.name}`, inferred);
        }
      }
    }
    licenseViolations = await emitLicenseAnnotations(licenseResults, allResults, inputs.licenseHeuristics, inferredLicenses);
    core.info(
      `License check: ${licenseResults.length} packages, ${licenseViolations} violation(s)`,
    );
    core.endGroup();
  }

  // Report
  await emitAnnotations(allResults, inputs.ecosystems, inputs.minAgeDays);
  await writeSummary(allResults, inputs.minAgeDays, inputs.warnAgeDays, licenseResults);

  const { checked, failures, warnings } = reportTotals(allResults);
  core.setOutput("total-checked", checked);
  core.setOutput("total-failures", failures);
  core.setOutput("total-warnings", warnings);
  core.setOutput("license-violations", licenseViolations);

  core.info(
    `Checked ${checked} packages, ${failures} failed, ${warnings} warnings, ${licenseViolations} license violation(s)`,
  );

  const totalFailures = failures + licenseViolations;

  if (totalFailures > 0) {
    const bypassed = inputs.bypassKeyword
      ? await checkBypass(inputs.bypassKeyword, inputs.githubToken)
      : false;

    if (bypassed) {
      core.warning(
        `Bypass keyword "${inputs.bypassKeyword}" detected — downgrading ${totalFailures} failure(s) to warnings`,
      );
    } else {
      const parts: string[] = [];
      if (failures > 0) {
        parts.push(`${failures} package(s) failed the ${inputs.minAgeDays}-day age gate`);
      }
      if (licenseViolations > 0) {
        parts.push(`${licenseViolations} package(s) have incompatible licenses`);
      }
      if (inputs.bypassKeyword) {
        parts.push(
          `To bypass, add "${inputs.bypassKeyword}" on its own line in your PR body or commit message, or add it as a PR label`,
        );
      }
      core.setFailed(parts.join(". "));
    }
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
