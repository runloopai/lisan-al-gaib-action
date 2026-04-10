import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import spdxCorrect from "spdx-correct";
import spdxSatisfies from "spdx-satisfies";
import type { RegistryUrls } from "./inputs.js";
import type { CheckResult } from "./ecosystems/types.js";

export interface LicenseResult {
  name: string;
  version: string;
  ecosystem: string;
  license: string | null;
  spdx: string | null;
  compatible: boolean | null; // null = could not determine
}

/**
 * Detect the project's SPDX license from the repository's package.json or LICENSE file.
 */
export async function detectProjectLicense(): Promise<string | null> {
  // Try package.json first
  try {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
    if (typeof pkg.license === "string") {
      const corrected = spdxCorrect(pkg.license);
      if (corrected) return corrected;
    }
  } catch {
    // no package.json or no license field
  }

  // Try LICENSE file
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"]) {
    try {
      const content = await fs.readFile(name, "utf8");
      return detectLicenseFromText(content);
    } catch {
      continue;
    }
  }

  return null;
}

function detectLicenseFromText(text: string): string | null {
  const upper = text.toUpperCase();
  if (upper.includes("MIT LICENSE") || upper.includes("PERMISSION IS HEREBY GRANTED, FREE OF CHARGE")) {
    return "MIT";
  }
  if (upper.includes("APACHE LICENSE") && upper.includes("VERSION 2.0")) {
    return "Apache-2.0";
  }
  if (upper.includes("GNU GENERAL PUBLIC LICENSE") && upper.includes("VERSION 3")) {
    return "GPL-3.0-only";
  }
  if (upper.includes("GNU GENERAL PUBLIC LICENSE") && upper.includes("VERSION 2")) {
    return "GPL-2.0-only";
  }
  if (upper.includes("BSD 3-CLAUSE") || upper.includes("THREE CLAUSE")) {
    return "BSD-3-Clause";
  }
  if (upper.includes("BSD 2-CLAUSE") || upper.includes("TWO CLAUSE") || upper.includes("SIMPLIFIED BSD")) {
    return "BSD-2-Clause";
  }
  if (upper.includes("ISC LICENSE")) {
    return "ISC";
  }
  if (upper.includes("UNLICENSE") || upper.includes("UNLICENCE")) {
    return "Unlicense";
  }
  return null;
}

/**
 * Default set of permissive licenses that are compatible with most projects.
 */
const DEFAULT_ALLOWED_LICENSES = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Zlib",
  "WTFPL",
  "BlueOak-1.0.0",
  "Python-2.0",
  "PSF-2.0",
];

/**
 * Get the list of allowed licenses. If the user provided a list, use that.
 * Otherwise, use the default permissive set.
 */
export function getAllowedLicenses(input: string): string[] {
  if (!input || input.toLowerCase() === "auto") {
    return DEFAULT_ALLOWED_LICENSES;
  }
  return input.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Check if a license is compatible with the allowed licenses list.
 */
export function isLicenseCompatible(
  license: string,
  allowedLicenses: string[],
): boolean {
  // Correct the license string first
  const corrected = spdxCorrect(license);
  const spdx = corrected ?? license;

  try {
    return spdxSatisfies(spdx, allowedLicenses);
  } catch {
    // If parsing fails, try exact match
    return allowedLicenses.some(
      (a) => a.toLowerCase() === spdx.toLowerCase(),
    );
  }
}

/**
 * Fetch the license for an npm package from the registry.
 */
export async function fetchNpmLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<string | null> {
  try {
    const resp = await fetch(`${registries.npm}/${name}/${version}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { license?: string };
    return data.license ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Python package from PyPI.
 */
export async function fetchPypiLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<string | null> {
  try {
    const resp = await fetch(`${registries.pypi}/pypi/${name}/${version}/json`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      info?: { license?: string; classifiers?: string[] };
    };
    // Try license field first
    if (data.info?.license && data.info.license !== "UNKNOWN") {
      return data.info.license;
    }
    // Try classifiers
    const licenseClassifier = data.info?.classifiers?.find((c) =>
      c.startsWith("License :: OSI Approved :: "),
    );
    if (licenseClassifier) {
      const parts = licenseClassifier.split(" :: ");
      return parts[parts.length - 1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Rust crate from crates.io.
 */
export async function fetchCrateLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<string | null> {
  try {
    const resp = await fetch(`${registries.crates}/api/v1/crates/${name}/${version}`, {
      headers: { "User-Agent": "dependency-age-check-action" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: { license?: string } };
    return data.version?.license ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Maven artifact by parsing the POM.
 */
export async function fetchMavenLicense(
  name: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<string | null> {
  const parts = name.split(":");
  if (parts.length < 2) return null;
  const groupPath = parts[0].replace(/\./g, "/");
  const artifact = parts[1];

  for (const repo of [...repositories, registries.maven]) {
    const base = repo.replace(/\/$/, "");
    const pomUrl = `${base}/${groupPath}/${artifact}/${version}/${artifact}-${version}.pom`;
    try {
      const resp = await fetch(pomUrl);
      if (!resp.ok) continue;
      const text = await resp.text();
      // Simple XML extraction for <license><name>...</name></license>
      const match = text.match(/<licenses>\s*<license>\s*<name>([^<]+)<\/name>/);
      if (match) return match[1].trim();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch the license for a GitHub repository (used for actions ecosystem).
 */
export async function fetchGitHubRepoLicense(
  name: string,
  token: string,
): Promise<string | null> {
  const parts = name.split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dependency-age-check-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/license`,
      { headers },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { license?: { spdx_id?: string } };
    const spdxId = data.license?.spdx_id;
    if (spdxId && spdxId !== "NOASSERTION") return spdxId;
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Bazel module from BCR metadata.
 */
export async function fetchBcrLicense(
  name: string,
  version: string,
  bcrUrl: string,
): Promise<string | null> {
  try {
    const url = `${bcrUrl.replace(/\/$/, "")}/modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/metadata.json`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { licenses?: string[] };
    if (data.licenses?.length) return data.licenses[0];
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a dependency based on its ecosystem.
 */
export async function fetchLicense(
  dep: { ecosystem: string; name: string; version: string },
  registries: RegistryUrls,
  javaRepoMap: Map<string, string[]>,
  githubToken: string,
  bcrUrl: string,
): Promise<string | null> {
  switch (dep.ecosystem) {
    case "npm":
      return fetchNpmLicense(dep.name, dep.version, registries);
    case "python":
      return fetchPypiLicense(dep.name, dep.version, registries);
    case "rust":
      return fetchCrateLicense(dep.name, dep.version, registries);
    case "java":
      return fetchMavenLicense(
        dep.name,
        dep.version,
        javaRepoMap.get(dep.name) ?? [],
        registries,
      );
    case "actions":
      return fetchGitHubRepoLicense(dep.name, githubToken);
    case "bazel":
      return fetchBcrLicense(dep.name, dep.version, bcrUrl);
    default:
      return null;
  }
}

/**
 * Check licenses for all analyzed dependencies and return results.
 */
export async function checkLicenses(
  results: CheckResult[],
  allowedLicenses: string[],
  registries: RegistryUrls,
  javaRepoMap: Map<string, string[]>,
  githubToken: string,
  bcrUrl: string,
): Promise<LicenseResult[]> {
  const licenseResults: LicenseResult[] = [];

  for (const { dep } of results) {
    const rawLicense = await fetchLicense(dep, registries, javaRepoMap, githubToken, bcrUrl);
    const spdx = rawLicense ? (spdxCorrect(rawLicense) ?? rawLicense) : null;
    let compatible: boolean | null = null;

    if (spdx) {
      compatible = isLicenseCompatible(spdx, allowedLicenses);
    }

    licenseResults.push({
      name: dep.name,
      version: dep.version,
      ecosystem: dep.ecosystem,
      license: rawLicense,
      spdx,
      compatible,
    });
  }

  return licenseResults;
}

/**
 * Emit annotations for license violations.
 */
export function emitLicenseAnnotations(
  licenseResults: LicenseResult[],
  checkResults: CheckResult[],
): number {
  let violations = 0;

  for (const lr of licenseResults) {
    if (lr.compatible === false) {
      const cr = checkResults.find(
        (r) => r.dep.name === lr.name && r.dep.version === lr.version,
      );
      core.error(
        `${lr.name}@${lr.version} has incompatible license: ${lr.spdx ?? lr.license}`,
        cr ? { file: cr.dep.file } : undefined,
      );
      violations++;
    } else if (lr.compatible === null && lr.license === null) {
      const cr = checkResults.find(
        (r) => r.dep.name === lr.name && r.dep.version === lr.version,
      );
      core.warning(
        `${lr.name}@${lr.version}: could not determine license`,
        cr ? { file: cr.dep.file } : undefined,
      );
    }
  }

  return violations;
}
