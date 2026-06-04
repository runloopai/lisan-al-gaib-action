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

// ─── OCI / Container Registry ────────────────────────────────────────────────

const OCI_INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Obtain an anonymous OCI bearer token for the given registry and repository
 * using the WWW-Authenticate challenge flow. Returns null if the registry
 * allows unauthenticated access (HTTP 200 on /v2/) or if authentication
 * fails (private registry).
 */
async function getOciToken(
  host: string,
  repository: string,
): Promise<string | null> {
  try {
    const pingResp = await fetch(`https://${host}/v2/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (pingResp.status === 200) return null; // no auth needed
    if (pingResp.status !== 401) return null; // private or unreachable

    const wwwAuth = pingResp.headers.get("www-authenticate") ?? "";
    const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
    if (!realmMatch) return null;
    const realm = realmMatch[1];

    const serviceMatch = wwwAuth.match(/service="([^"]+)"/);
    const service = serviceMatch ? serviceMatch[1] : "";

    const tokenUrl =
      `${realm}?service=${encodeURIComponent(service)}` +
      `&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;

    const data = (await fetchJson(tokenUrl)) as
      | { token?: string; access_token?: string }
      | null;
    return data?.token ?? data?.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchOciManifest(
  host: string,
  repository: string,
  reference: string,
  token: string | null,
): Promise<{ contentType: string; body: unknown; lastModified: string | null } | null> {
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(
      `https://${host}/v2/${repository}/manifests/${reference}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "";
    const lastModified = resp.headers.get("last-modified");
    const body = (await resp.json()) as unknown;
    return { contentType, body, lastModified };
  } catch {
    return null;
  }
}

function parseLastModified(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime()) || date.getFullYear() < 2000) return null;
  return date;
}

/**
 * Docker Hub Hub API: returns the tag_last_pushed timestamp for a tag — the
 * actual time the image was pushed to Docker Hub, not the build time.
 * repository is already normalized to "library/<name>" or "user/repo" form.
 */
async function dockerHubPushDate(
  repository: string,
  tag: string,
): Promise<Date | null> {
  const [namespace, ...rest] = repository.split("/");
  const repoName = rest.join("/");
  const url =
    `https://hub.docker.com/v2/repositories/${namespace}/${repoName}/tags` +
    `?name=${encodeURIComponent(tag)}&page_size=25`;
  const data = (await fetchJson(url)) as {
    results?: Array<{ name: string; tag_last_pushed?: string }>;
  } | null;
  const result = data?.results?.find((r) => r.name === tag);
  return parseLastModified(result?.tag_last_pushed ?? null);
}


/**
 * Fetch the push timestamp for a container image via registry-specific APIs
 * and the OCI Distribution v2 protocol.
 *
 * For Docker Hub images with a known tag, queries the Hub API for
 * `tag_last_pushed` (the actual push timestamp). For all other registries,
 * or as a fallback, reads the `Last-Modified` HTTP header from the manifest
 * GET response — the time the registry stored that content-addressed manifest,
 * which is the push time (best-effort; not guaranteed by the OCI Distribution
 * spec).
 *
 * Returns null for private registries (anonymous auth rejected), unreachable
 * registries, or registries that do not expose a push timestamp.
 */
export async function fetchImagePublishDate(
  registry: string,
  repository: string,
  digest: string,
  tag: string | null = null,
): Promise<Date | null> {
  const host =
    registry === "docker.io" || registry === "index.docker.io"
      ? "registry-1.docker.io"
      : registry;

  try {
    // Docker Hub exposes tag_last_pushed via the Hub web API — the real push time
    if ((registry === "docker.io" || registry === "index.docker.io") && tag) {
      const date = await dockerHubPushDate(repository, tag);
      if (date) return date;
    }

    // Universal fallback: Last-Modified on the manifest response = push time
    const token = await getOciToken(host, repository);

    const manifest = await fetchOciManifest(host, repository, digest, token);
    if (!manifest) return null;

    const mediaType = manifest.contentType.split(";")[0].trim();

    if (OCI_INDEX_MEDIA_TYPES.has(mediaType)) {
      // Multi-arch index: drill into preferred child and use its Last-Modified
      const index = manifest.body as {
        manifests?: Array<{
          digest: string;
          platform?: { os?: string; architecture?: string };
        }>;
      };
      if (!index.manifests?.length) return null;

      const child =
        index.manifests.find(
          (m) =>
            m.platform?.os === "linux" &&
            m.platform?.architecture === "amd64",
        ) ?? index.manifests[0];

      const childManifest = await fetchOciManifest(
        host,
        repository,
        child.digest,
        token,
      );
      if (!childManifest) return null;
      return parseLastModified(childManifest.lastModified);
    }

    return parseLastModified(manifest.lastModified);
  } catch {
    return null;
  }
}

async function fetchOciBlobJson(
  host: string,
  repository: string,
  digest: string,
  token: string | null,
): Promise<unknown | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const resp = await fetch(
      `https://${host}/v2/${repository}/blobs/${digest}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Fetch the OCI image config labels for a container image.
 * Returns the image's config.Labels map, or null on any failure.
 * Works anonymously on public registries; private registries → null.
 */
export async function fetchImageLabels(
  registry: string,
  repository: string,
  reference: string,
): Promise<Record<string, string> | null> {
  const host =
    registry === "docker.io" || registry === "index.docker.io"
      ? "registry-1.docker.io"
      : registry;
  try {
    const token = await getOciToken(host, repository);
    let manifest = await fetchOciManifest(host, repository, reference, token);
    if (!manifest) return null;

    const mediaType = manifest.contentType.split(";")[0].trim();
    if (OCI_INDEX_MEDIA_TYPES.has(mediaType)) {
      const index = manifest.body as {
        manifests?: Array<{
          digest: string;
          platform?: { os?: string; architecture?: string };
        }>;
      };
      if (!index.manifests?.length) return null;
      const child =
        index.manifests.find(
          (m) =>
            m.platform?.os === "linux" &&
            m.platform?.architecture === "amd64",
        ) ?? index.manifests[0];
      manifest = await fetchOciManifest(host, repository, child.digest, token);
      if (!manifest) return null;
    }

    const body = manifest.body as { config?: { digest?: string } };
    const configDigest = body.config?.digest;
    if (!configDigest) return null;

    const config = await fetchOciBlobJson(host, repository, configDigest, token);
    const cfg = config as { config?: { Labels?: Record<string, string> } } | null;
    return cfg?.config?.Labels ?? null;
  } catch {
    return null;
  }
}

/**
 * Check whether a manifest reference exists in an OCI registry without
 * downloading its content. Uses a HEAD request per the OCI Distribution v2
 * spec.
 *
 * Returns:
 *   "found"    — HTTP 200 (manifest exists and is publicly accessible)
 *   "notfound" — HTTP 404 (reference does not exist in the registry)
 *   "unknown"  — any other status (401 private, 429 rate-limit, network
 *                error, or thrown exception) — caller should not treat the
 *                reference as either present or absent
 */
export async function imageExists(
  registry: string,
  repository: string,
  reference: string,
): Promise<"found" | "notfound" | "unknown"> {
  const host =
    registry === "docker.io" || registry === "index.docker.io"
      ? "registry-1.docker.io"
      : registry;
  try {
    const token = await getOciToken(host, repository);
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (token) headers.Authorization = `Bearer ${token}`;

    const resp = await fetch(
      `https://${host}/v2/${repository}/manifests/${reference}`,
      { method: "HEAD", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );

    if (resp.status === 200) return "found";
    if (resp.status === 404) return "notfound";
    return "unknown";
  } catch {
    return "unknown";
  }
}
