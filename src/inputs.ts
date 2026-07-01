import * as core from "@actions/core";
import yaml from "js-yaml";

export const DEFAULT_MIN_AGE_DAYS = 14;

export type LicenseOverrides = Map<string, Map<string, string>>;
export type AgeOverrides = Map<string, Set<string>>;

export interface RegistryUrls {
  npm: string;
  pypi: string;
  crates: string;
  maven: string;
}

export interface ActionInputs {
  ecosystems: string[];
  minAgeDays: number;
  warnAgeDays: number;
  baseRef: string;
  nodeLockfiles: string;
  pythonLockfiles: string;
  moduleBazel: string;
  registries: RegistryUrls;
  checkAllOnNewWorkflow: boolean;
  strictThirdParty: boolean;
  bypassKeyword: string;
  workflowFiles: string;
  kubernetesFiles: string;
  dockerfiles: string;
  dockerhubMirror: string;
  githubToken: string;
  bcrUrl: string;
  allowedLicenses: string;
  licenseOverrides: LicenseOverrides;
  ageOverrides: AgeOverrides;
  licenseHeuristics: boolean;
  fetchMissingHistoryRetries: number;
}

export function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export const DEFAULT_REGISTRIES = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
  maven: "https://repo1.maven.org/maven2",
  /** Default Bazel Central Registry URL — shared by CLI and latest.ts. */
  bcrUrl: "https://bcr.bazel.build",
} as const;

export function getInputs(): ActionInputs {
  const ecosystems = core
    .getInput("ecosystems", { required: true })
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const parsedMin = parseInt(core.getInput("min-age-days") || String(DEFAULT_MIN_AGE_DAYS), 10);
  const minAgeDaysRaw = isNaN(parsedMin) ? DEFAULT_MIN_AGE_DAYS : parsedMin;
  // Fail closed rather than silently clamp: min-age-days is the core security control this
  // action exists to enforce, so a negative value (typo, or an attacker-controlled workflow
  // input) must not be quietly downgraded to "gate disabled" — the run should stop and force
  // the value to be fixed explicitly (use 0 to disable the age gate on purpose).
  if (minAgeDaysRaw < 0) {
    throw new Error(
      `min-age-days (${minAgeDaysRaw}) is negative. Set it to 0 explicitly to disable the age gate.`,
    );
  }
  const minAgeDays = minAgeDaysRaw;

  const parsedWarn = parseInt(core.getInput("warn-age-days") || "21", 10);
  const warnAgeDaysRaw = isNaN(parsedWarn) ? 21 : parsedWarn;
  if (warnAgeDaysRaw < 0) {
    core.warning(
      `warn-age-days (${warnAgeDaysRaw}) is negative — clamping to 0.`,
    );
  }
  const warnAgeDays = Math.max(0, warnAgeDaysRaw);

  const parsedRetries = parseInt(core.getInput("fetch-missing-history-retries") || "10", 10);
  const fetchMissingHistoryRetries = isNaN(parsedRetries) || parsedRetries < 0 ? 10 : parsedRetries;

  if (warnAgeDays < minAgeDays) {
    core.warning(
      `warn-age-days (${warnAgeDays}) is less than min-age-days (${minAgeDays}); no warnings will be produced`,
    );
  }

  // target-licenses supersedes allowed-licenses
  const targetLicenses = core.getInput("target-licenses");
  const allowedLicenses = core.getInput("allowed-licenses");
  let effectiveLicenses: string;
  if (targetLicenses) {
    effectiveLicenses = targetLicenses;
  } else if (allowedLicenses) {
    core.warning(
      "allowed-licenses is deprecated; use target-licenses instead",
    );
    effectiveLicenses = allowedLicenses;
  } else {
    effectiveLicenses = "auto";
  }

  return {
    ecosystems,
    minAgeDays,
    warnAgeDays,
    baseRef: core.getInput("base-ref"),
    nodeLockfiles: core.getInput("node-lockfiles"),
    pythonLockfiles: core.getInput("python-lockfiles"),
    moduleBazel: core.getInput("module-bazel") || "MODULE.bazel",
    checkAllOnNewWorkflow: core.getBooleanInput("check-all-on-new-workflow"),
    strictThirdParty: core.getBooleanInput("strict-third-party"),
    bypassKeyword: core.getInput("bypass-keyword"),
    workflowFiles: core.getInput("workflow-files"),
    kubernetesFiles: core.getInput("kubernetes-files"),
    dockerfiles: core.getInput("dockerfiles"),
    dockerhubMirror: core.getInput("dockerhub-mirror"),
    githubToken: core.getInput("github-token"),
    bcrUrl: trimSlash(core.getInput("bcr-url") || "https://bcr.bazel.build"),
    allowedLicenses: effectiveLicenses,
    licenseOverrides: parseLicenseOverrides(
      core.getInput("license-overrides"),
    ),
    ageOverrides: parseAgeOverrides(
      core.getInput("age-overrides"),
    ),
    licenseHeuristics: core.getBooleanInput("license-heuristics"),
    fetchMissingHistoryRetries,
    registries: {
      npm: trimSlash(core.getInput("npm-registry-url") || DEFAULT_REGISTRIES.npm),
      pypi: trimSlash(core.getInput("pypi-registry-url") || DEFAULT_REGISTRIES.pypi),
      crates: trimSlash(core.getInput("crates-registry-url") || DEFAULT_REGISTRIES.crates),
      maven: trimSlash(core.getInput("maven-registry-url") || DEFAULT_REGISTRIES.maven),
    },
  };
}

function parseNestedYamlMap(input: string, inputName: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  if (!input) return result;

  try {
    const parsed = yaml.load(input) as Record<
      string,
      Record<string, string>
    > | null;
    if (!parsed || typeof parsed !== "object") return result;

    for (const [ecosystem, packages] of Object.entries(parsed)) {
      if (!packages || typeof packages !== "object") continue;
      const pkgMap = new Map<string, string>();
      for (const [pkg, value] of Object.entries(packages)) {
        if (typeof value === "string") {
          pkgMap.set(pkg, value);
        }
      }
      if (pkgMap.size > 0) {
        result.set(ecosystem, pkgMap);
      }
    }
  } catch (e) {
    core.warning(`Failed to parse ${inputName}: ${e}`);
  }

  return result;
}

export function parseLicenseOverrides(input: string): LicenseOverrides {
  return parseNestedYamlMap(input, "license-overrides");
}

export function parseAgeOverrides(input: string): AgeOverrides {
  const result = new Map<string, Set<string>>();
  if (!input) return result;

  try {
    const parsed = yaml.load(input) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return result;

    for (const [ecosystem, value] of Object.entries(parsed)) {
      const pkgSet = new Set<string>();
      if (Array.isArray(value)) {
        // New format: ecosystem: [pkg1, pkg2]
        for (const item of value) {
          if (typeof item === "string") pkgSet.add(item);
        }
      } else if (value && typeof value === "object") {
        // Legacy format: ecosystem: { pkg: ignore }
        for (const pkg of Object.keys(value as Record<string, unknown>)) {
          pkgSet.add(pkg);
        }
      }
      if (pkgSet.size > 0) {
        result.set(ecosystem, pkgSet);
      }
    }
  } catch (e) {
    core.warning(`Failed to parse age-overrides: ${e}`);
  }

  return result;
}
