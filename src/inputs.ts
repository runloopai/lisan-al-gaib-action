import * as core from "@actions/core";

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
  moduleBazelLock: string;
  workflowFiles: string;
  githubToken: string;
  bcrUrl: string;
  allowedLicenses: string;
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

  const minAgeDays = parseInt(core.getInput("min-age-days") || "14", 10);
  const warnAgeDays = parseInt(core.getInput("warn-age-days") || "21", 10);

  if (warnAgeDays < minAgeDays) {
    core.warning(
      `warn-age-days (${warnAgeDays}) is less than min-age-days (${minAgeDays}); no warnings will be produced`,
    );
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
    moduleBazelLock: core.getInput("module-bazel-lock") || "MODULE.bazel.lock",
    workflowFiles: core.getInput("workflow-files"),
    githubToken: core.getInput("github-token"),
    bcrUrl: trimSlash(core.getInput("bcr-url") || "https://bcr.bazel.build"),
    allowedLicenses: core.getInput("allowed-licenses") || "auto",
    registries: {
      npm: trimSlash(core.getInput("npm-registry-url") || "https://registry.npmjs.org"),
      pypi: trimSlash(core.getInput("pypi-registry-url") || "https://pypi.org"),
      crates: trimSlash(core.getInput("crates-registry-url") || "https://crates.io"),
      maven: trimSlash(core.getInput("maven-registry-url") || "https://repo1.maven.org/maven2"),
    },
  };
}
