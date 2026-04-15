import * as core from "@actions/core";
import yaml from "js-yaml";

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
  githubToken: string;
  bcrUrl: string;
  allowedLicenses: string;
  licenseOverrides: LicenseOverrides;
  ageOverrides: AgeOverrides;
  licenseHeuristics: boolean;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export function getInputs(): ActionInputs {
  const ecosystems = core
    .getInput("ecosystems", { required: true })
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const parsedMin = parseInt(core.getInput("min-age-days") || "14", 10);
  const minAgeDays = isNaN(parsedMin) ? 14 : parsedMin;
  const parsedWarn = parseInt(core.getInput("warn-age-days") || "21", 10);
  const warnAgeDays = isNaN(parsedWarn) ? 21 : parsedWarn;

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
    registries: {
      npm: trimSlash(core.getInput("npm-registry-url") || "https://registry.npmjs.org"),
      pypi: trimSlash(core.getInput("pypi-registry-url") || "https://pypi.org"),
      crates: trimSlash(core.getInput("crates-registry-url") || "https://crates.io"),
      maven: trimSlash(core.getInput("maven-registry-url") || "https://repo1.maven.org/maven2"),
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
