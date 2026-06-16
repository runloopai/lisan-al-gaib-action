import * as core from "@actions/core";
import * as github from "@actions/github";
import { checkBypass, isPrEvent, INTERACTIVE_PUSH_EVENTS } from "./bypass.js";
import { getInputs } from "./inputs.js";
import { resolveBaseRef, makeBaseRefDiffable, EMPTY_TREE } from "./base-ref.js";
import { gitDiffFiltered, setDiffSource } from "./diff.js";
import { createApiDiffSource } from "./api-diff.js";
import * as npm from "./ecosystems/npm.js";
import * as python from "./ecosystems/python.js";
import * as rust from "./ecosystems/rust.js";
import * as java from "./ecosystems/java.js";
import * as bazelModule from "./ecosystems/bazel-module.js";
import * as actions from "./ecosystems/actions.js";
import * as docker from "./ecosystems/docker.js";
import * as multitool from "./ecosystems/multitool.js";
import * as kubernetes from "./ecosystems/kubernetes.js";
import { bcrPublishDate, gitCommitDate, archiveDate } from "./registry.js";
import { computeAgeDays } from "./age.js";
import type { BazelOverride, ParsedImageRef } from "./ecosystems/types.js";
import {
  determineStatus,
  emitAnnotations,
  writeSummary,
  reportTotals,
  dedupeResults,
} from "./report.js";
import {
  getTargetLicenses,
  checkLicenses,
  emitLicenseAnnotations,
  fetchLicense,
  getWorkflowFile,
} from "./license.js";
import type { ChangedDep, CheckResult } from "./ecosystems/types.js";
import { SUPPORTED_ECOSYSTEMS as UPDATE_CLI_ECOSYSTEMS } from "./update/ecosystems.js";
import type { ECOSYSTEM_REGISTRY } from "./update/ecosystem-registry.js";
import { resolveCacheKey } from "./update/cache-key.js";
import { dedupeAndResolve, RESOLVE_CONCURRENCY } from "./update/resolve.js";

/**
 * Check if the workflow file that triggered this run was newly added.
 * If so, return an empty-tree ref to force checking all packages.
 */
async function resolveEffectiveBaseRef(
  baseRef: string,
  checkAllOnNewWorkflow: boolean,
): Promise<string> {
  if (!checkAllOnNewWorkflow) return baseRef;

  const workflowPath = getWorkflowFile();
  if (!workflowPath) return baseRef;

  core.info(`Workflow file: ${workflowPath}`);

  // Use --diff-filter=A to only match truly added files, not renames
  const addedFiles = await gitDiffFiltered(baseRef, "A");
  if (!addedFiles.includes(workflowPath)) return baseRef;

  core.info(
    `Workflow file ${workflowPath} is newly added — checking ALL packages`,
  );

  // Empty tree SHA — forces diffing everything
  return EMPTY_TREE;
}


// ECOSYSTEM_SYNC: keep in sync with ECOSYSTEM_DISPATCH in src/update/run.ts and resolveLatest switch in src/update/latest.ts
async function lookupPublishDate(
  dep: ChangedDep,
  inputs: ReturnType<typeof getInputs>,
  javaRepoMap: Map<string, string[]>,
  bazelOverrides: Map<string, BazelOverride>,
  kubernetesImageRefs: Map<string, ParsedImageRef>,
  dockerImageRefs: Map<string, ParsedImageRef>,
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
      const isSha = actions.isCommitSha(dep.version);
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
    case "kubernetes":
      return kubernetes.getPublishDate(
        kubernetesImageRefs.get(`${dep.name}@${dep.version}`),
      );
    case "docker":
      return docker.getPublishDate(
        dockerImageRefs.get(`${dep.name}@${dep.version}`),
      );
    default:
      return null;
  }
}

// Compile-time exhaustiveness guard: every ecosystem key in the updater ECOSYSTEM_REGISTRY
// must have an explicit `case` in the lookupPublishDate switch above. If a new ecosystem is
// added to ECOSYSTEM_REGISTRY without a corresponding case here, the Exclude below becomes
// non-never and TypeScript flags this line as a type error.
// When adding a new ecosystem: (1) add the case, (2) extend the union here.
(null as unknown as Exclude<
  keyof typeof ECOSYSTEM_REGISTRY,
  "actions" | "docker" | "kubernetes" | "rust" | "java" | "bazel"
>) satisfies never;

async function run(): Promise<void> {
  const inputs = getInputs();
  const rawBaseRef = resolveBaseRef(inputs.baseRef);
  const plan = await makeBaseRefDiffable(rawBaseRef, {
    fetchRetries: inputs.fetchMissingHistoryRetries,
  });

  let diffableRef: string;
  if (plan.mode === "api") {
    if (!inputs.githubToken) {
      core.warning(
        "No github-token provided — cannot use GitHub compare API; falling back to checking all packages",
      );
      diffableRef = EMPTY_TREE;
    } else {
      try {
        const { owner, repo: repoName } = github.context.repo;
        const source = createApiDiffSource({
          octokit: github.getOctokit(inputs.githubToken),
          owner,
          repo: repoName,
          baseSha: plan.baseSha,
          headSha: plan.headSha,
        });
        await source.diffNameOnly(); // warm call — surface API errors before ecosystems run
        setDiffSource(source);
        diffableRef = plan.baseSha;
      } catch (err) {
        core.warning(
          `GitHub compare API unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to checking all packages`,
        );
        diffableRef = EMPTY_TREE;
      }
    }
  } else {
    diffableRef = plan.baseRef;
  }

  const baseRef = await resolveEffectiveBaseRef(
    diffableRef,
    inputs.checkAllOnNewWorkflow,
  );
  // Empty tree is always locally diffable — ensure git mode is active
  if (baseRef === EMPTY_TREE) {
    setDiffSource(null);
  }

  core.info(
    `Dependency age check — min: ${inputs.minAgeDays}d, warn: ${inputs.warnAgeDays}d, base: ${baseRef}`,
  );

  let allResults: CheckResult[] = [];

  // Cache for publish date lookups: "ecosystem:name@version" → Date | null
  const publishDateCache = new Map<string, Date | null>();

  // Per-ecosystem metadata maps
  let javaRepoMap = new Map<string, string[]>();
  let bazelOverrides = new Map<string, BazelOverride>();
  let kubernetesImageRefs = new Map<string, ParsedImageRef>();
  let dockerImageRefs = new Map<string, ParsedImageRef>();

  for (const eco of inputs.ecosystems) {
    core.startGroup(`=== ${eco} ===`);

    let deps: ChangedDep[];

    try {
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
          deps = await actions.getChangedDeps(baseRef, inputs.workflowFiles, inputs.githubToken);
          break;
        case "multitool":
          deps = await multitool.getChangedDeps(
            baseRef,
            inputs.moduleBazel,
          );
          break;
        case "kubernetes": {
          const result = await kubernetes.getChangedDeps(
            baseRef,
            inputs.kubernetesFiles,
          );
          deps = result.deps;
          kubernetesImageRefs = result.imageRefs;
          break;
        }
        case "docker": {
          const result = await docker.getChangedDeps(
            baseRef,
            inputs.dockerfiles,
            inputs.dockerhubMirror,
          );
          deps = result.deps;
          dockerImageRefs = result.imageRefs;
          break;
        }
        default:
          core.setFailed(`Unknown ecosystem: ${eco}`);
          core.endGroup();
          // continue to remaining ecosystems rather than aborting the entire run —
          // other ecosystems should still be checked even if one is unknown/misspelled.
          continue;
      }
    } catch (err) {
      // A getChangedDeps failure must NOT silently pass (fail-open). Marking the
      // action failed ensures the PR is blocked while still letting the remaining
      // ecosystems run. A transient error (registry outage, WASM load failure,
      // malformed lockfile) skipping one ecosystem would allow new packages in that
      // ecosystem to bypass the age gate entirely.
      core.setFailed(
        `${eco}: getChangedDeps failed — cannot safely check this ecosystem: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      core.endGroup();
      continue;
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

    // Deduplicate by cache key and resolve publish dates with bounded concurrency.
    // Skip deps already in the cache (from a previous ecosystem iteration).
    // dedupeAndResolve returns null for failed resolutions — stored as null in cache
    // to record "lookup was attempted but failed" (avoids re-fetching on future iterations).
    const depsForLookup = filteredDeps.filter(
      (dep) => !publishDateCache.has(resolveCacheKey(dep.ecosystem, dep.name, dep.version)),
    );
    const lookupResults = await dedupeAndResolve(
      depsForLookup,
      (dep) => resolveCacheKey(dep.ecosystem, dep.name, dep.version),
      (dep) => lookupPublishDate(dep, inputs, javaRepoMap, bazelOverrides, kubernetesImageRefs, dockerImageRefs),
      RESOLVE_CONCURRENCY,
      core.warning,
    );
    for (const [key, value] of lookupResults) {
      publishDateCache.set(key, value);
    }

    for (const dep of filteredDeps) {
      const cacheKey = resolveCacheKey(dep.ecosystem, dep.name, dep.version);
      const publishDate = publishDateCache.get(cacheKey) ?? null;

      const ageDays = computeAgeDays(publishDate);

      const status = determineStatus(
        ageDays,
        inputs.minAgeDays,
        inputs.warnAgeDays,
      );

      allResults.push({ dep, publishDate, ageDays, status });
    }

    core.endGroup();
  }

  allResults = dedupeResults(allResults);

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
      kubernetesImageRefs,
      dockerImageRefs,
    );
    // When heuristics is off, still try to infer licenses for suggestion purposes
    let inferredLicenses: Map<string, string> | undefined;
    if (!inputs.licenseHeuristics) {
      inferredLicenses = new Map();
      const unknowns = licenseResults.filter((lr) => lr.compatible === null && lr.license === null);
      for (const lr of unknowns) {
        const dep = { ecosystem: lr.ecosystem, name: lr.name, version: lr.version };
        const inferred = await fetchLicense(dep, inputs.registries, javaRepoMap, inputs.githubToken, inputs.bcrUrl, true, kubernetesImageRefs, dockerImageRefs);
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
      if (failures > 0) {
        // Suggest the update CLI for ecosystems it supports (direct deps only).
        // npm/python/multitool are excluded — the update CLI does not yet support them.
        // Bazel deps governed by git/archive/local_path/multiple_version overrides are
        // also excluded — the updater can only bump bazel_dep()s with a BCR version.
        const failingByEco = new Map<string, string[]>();
        for (const r of allResults) {
          if (r.status !== "fail" || !UPDATE_CLI_ECOSYSTEMS.has(r.dep.ecosystem)) continue;
          if (r.dep.ecosystem === "bazel") {
            const override = bazelOverrides.get(r.dep.name);
            if (override && override.type !== "single_version") continue;
          }
          const pkgs = failingByEco.get(r.dep.ecosystem) ?? [];
          if (!pkgs.includes(r.dep.name)) pkgs.push(r.dep.name);
          failingByEco.set(r.dep.ecosystem, pkgs);
        }
        if (failingByEco.size > 0) {
          const ecosystemArg = [...failingByEco.keys()].join(",");
          // Note: the `update` CLI updates ALL age-failing deps in those ecosystems,
          // not a filtered subset — per-package filtering is not supported in v1.
          parts.push(
            `To update these packages interactively, run: npx -p github:runloopai/lisan-al-gaib-action update ${ecosystemArg} --min-age ${inputs.minAgeDays}` +
            ` (to search for older versions that meet the age gate instead, add: --allow-downgrade only)`,
          );
        }
      }
      if (inputs.bypassKeyword) {
        // Three-way hint that matches the actual bypass paths in bypass.ts:
        //   PR events       → PR label only (commit message is contributor-editable)
        //   push events     → commit message (HEAD commit, authored by pusher) OR PR label
        //   unattended runs → PR label only (commit-message bypass disabled on schedule/
        //                     workflow_dispatch/etc. to prevent a pre-planted keyword from
        //                     silently bypassing every future unattended run)
        const bypassHint = isPrEvent()
          ? `To bypass, add "${inputs.bypassKeyword}" as a PR label`
          : INTERACTIVE_PUSH_EVENTS.has(github.context.eventName)
            ? `To bypass, add "${inputs.bypassKeyword}" on its own line in the HEAD commit message, or add it as a label on the associated PR`
            : `To bypass, add "${inputs.bypassKeyword}" as a label on the associated PR (commit-message bypass is disabled on unattended events)`;
        parts.push(bypassHint);
      }
      core.setFailed(parts.join(". "));
    }
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
