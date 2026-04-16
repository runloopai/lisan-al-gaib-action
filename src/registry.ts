import * as core from "@actions/core";
import type { RegistryUrls } from "./inputs.js";

const MAVEN_CENTRAL_PREFIXES = [
  "https://repo1.maven.org/maven2",
  "https://repo.maven.apache.org/maven2",
  "http://repo1.maven.org/maven2",
  "http://central.maven.org/maven2",
];

const FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(
  url: string,
  headers?: Record<string, string>,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Replace Maven Central URLs with the configured registry URL.
 * Non-Central URLs (private repos, etc.) are left untouched.
 */
function resolveMavenRepo(repoUrl: string, registries: RegistryUrls): string {
  const normalized = repoUrl.replace(/\/$/, "");
  for (const prefix of MAVEN_CENTRAL_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + "/")) {
      return registries.maven;
    }
  }
  return normalized;
}

export async function npmPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  const data = (await fetchJson(`${registries.npm}/${name}`)) as {
    time?: Record<string, string>;
  } | null;
  const time = data?.time?.[version];
  return time ? new Date(time) : null;
}

export async function pypiPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  const data = (await fetchJson(
    `${registries.pypi}/pypi/${name}/${version}/json`,
  )) as {
    urls?: Array<{ upload_time_iso_8601?: string }>;
  } | null;
  const time = data?.urls?.[0]?.upload_time_iso_8601;
  return time ? new Date(time) : null;
}

export async function cratesPublishDate(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<Date | null> {
  const data = (await fetchJson(
    `${registries.crates}/api/v1/crates/${name}`,
    { "User-Agent": "lisan-al-gaib-action" },
  )) as {
    versions?: Array<{ num: string; created_at?: string }>;
  } | null;
  const entry = data?.versions?.find((v) => v.num === version);
  return entry?.created_at ? new Date(entry.created_at) : null;
}

export async function mavenPublishDate(
  group: string,
  artifact: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
): Promise<Date | null> {
  const groupPath = group.replace(/\./g, "/");

  // Try each configured repository via HEAD on POM
  for (const repo of repositories) {
    const base = resolveMavenRepo(repo, registries);
    const pomUrl = `${base}/${groupPath}/${artifact}/${version}/${artifact}-${version}.pom`;
    try {
      const resp = await fetch(pomUrl, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (resp.ok) {
        const lastModified = resp.headers.get("Last-Modified");
        if (lastModified) {
          return new Date(lastModified);
        }
      }
    } catch {
      // continue to next repo
    }
  }

  // Fall back to Maven Central search API
  const data = (await fetchJson(
    `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(group)}+AND+a:${encodeURIComponent(artifact)}+AND+v:${encodeURIComponent(version)}&rows=1&wt=json`,
  )) as {
    response?: { docs?: Array<{ timestamp?: number }> };
  } | null;
  const ts = data?.response?.docs?.[0]?.timestamp;
  if (ts) {
    return new Date(ts);
  }

  core.debug(
    `Could not find publish date for ${group}:${artifact}:${version}`,
  );
  return null;
}

/**
 * Get publish date from the Bazel Central Registry.
 * Strategy: query the BCR GitHub repo for the commit that added the module version.
 */
export async function bcrPublishDate(
  name: string,
  version: string,
  token: string,
  bcrUrl: string,
): Promise<Date | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lisan-al-gaib-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Derive BCR GitHub owner/repo from the registry URL
  // Default BCR: https://bcr.bazel.build/ → bazelbuild/bazel-central-registry
  let bcrOwner = "bazelbuild";
  let bcrRepo = "bazel-central-registry";

  // Try to extract from a GitHub-based registry URL
  const ghMatch = bcrUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (ghMatch) {
    bcrOwner = ghMatch[1];
    bcrRepo = ghMatch[2];
  }

  // Query the BCR repo for the commit that added this module version
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${bcrOwner}/${bcrRepo}/commits?path=modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/MODULE.bazel&per_page=1`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (resp.ok) {
      const data = (await resp.json()) as Array<{
        commit?: { committer?: { date?: string } };
      }>;
      const date = data?.[0]?.commit?.committer?.date;
      if (date) return new Date(date);
    }
  } catch {
    // fall through
  }

  // Fallback: try fetching source.json and HEAD the archive URL for Last-Modified
  try {
    const sourceUrl = `${bcrUrl.replace(/\/$/, "")}/modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/source.json`;
    const sourceResp = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (sourceResp.ok) {
      const sourceData = (await sourceResp.json()) as { url?: string };
      if (sourceData.url) {
        const archiveResp = await fetch(sourceData.url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const lastModified = archiveResp.headers.get("Last-Modified");
        if (lastModified) return new Date(lastModified);
      }
    }
  } catch {
    // fall through
  }

  core.debug(`Could not find publish date for bazel module ${name}@${version}`);
  return null;
}

/**
 * Get the date of a git commit from a remote repository.
 * Parses the remote URL to extract GitHub owner/repo and queries the API.
 */
export async function gitCommitDate(
  remote: string,
  ref: string,
  token: string,
): Promise<Date | null> {
  // Parse GitHub remote URL
  const ghMatch = remote.match(
    /github\.com[/:]([^/]+)\/([^/.]+)/,
  );
  if (!ghMatch) {
    core.debug(`gitCommitDate: cannot parse remote URL: ${remote}`);
    return null;
  }

  const owner = ghMatch[1];
  const repo = ghMatch[2];

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lisan-al-gaib-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      commit?: { committer?: { date?: string } };
    };
    const date = data?.commit?.committer?.date;
    return date ? new Date(date) : null;
  } catch {
    return null;
  }
}

/**
 * Get Last-Modified date from an archive URL via HEAD request.
 */
export async function archiveDate(url: string): Promise<Date | null> {
  try {
    const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const lastModified = resp.headers.get("Last-Modified");
    return lastModified ? new Date(lastModified) : null;
  } catch {
    return null;
  }
}
