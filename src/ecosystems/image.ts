import * as core from "@actions/core";
import { fetchImagePublishDate, imageExists, ociDigestForTag } from "../registry.js";
import { computeAgeDays } from "../age.js";
import type { ParsedImageRef } from "./types.js";

const mutableSkipLogged = new Set<string>();

/**
 * OCI distribution reference grammar for repository paths (registry stripped).
 * path-component = [a-z0-9]+ (separator [a-z0-9]+)*
 * separator       = [._] | __ | -+
 * repository      = path-component ('/' path-component)*
 *
 * This rejects placeholder tokens like __DIND_IMAGE__, {{image}}, %VAR%,
 * uppercase names, and any other string that is not a legal image name.
 */
const REPOSITORY_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;

/**
 * Parse an OCI/Docker image reference string into its components.
 *
 * Grammar: [registry[:port]/]repository[:tag][@digest]
 * Registry detection: first path segment is a host if it contains '.' or a
 * numeric port suffix (':' + all-digits) or equals 'localhost'. Otherwise the
 * image is on Docker Hub. Single-segment Docker Hub repos are normalized to
 * library/<name> so API lookups work (e.g. "postgres" → "library/postgres").
 * Returns null for references whose repository path is not a legal OCI name
 * (e.g. placeholder tokens like __DIND_IMAGE__, uppercase refs, etc.).
 *
 * Inherent ambiguity: a slash-less reference whose sole segment looks like
 * "host:port" (e.g. "registry.example.com:5000") is indistinguishable from a
 * bare "name:tag" and is always parsed as the latter (Docker Hub repository
 * "registry.example.com", tag "5000") — a registry host alone, with no
 * repository path, is not a meaningful image reference in this grammar, so
 * this case is not expected to occur in practice.
 */
export function parseImageRef(raw: string): ParsedImageRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Split off digest (everything after the last '@').
  // Only treat as a digest if it has the algorithm:hex form (e.g. sha256:...).
  // Bare @tag typos like "nginx@latest" don't contain ':' and are left as-is
  // (digest remains null, treated as mutable tag-only → unknown).
  const atIdx = trimmed.lastIndexOf("@");
  let digest: string | null = null;
  let refPart: string;
  if (atIdx !== -1) {
    const candidate = trimmed.slice(atIdx + 1);
    if (candidate.includes(":")) {
      digest = candidate;
      refPart = trimmed.slice(0, atIdx);
    } else {
      refPart = trimmed;
    }
  } else {
    refPart = trimmed;
  }

  // Determine registry host vs repository+tag
  let registry: string;
  let repoAndTag: string;

  const slashIdx = refPart.indexOf("/");
  if (slashIdx !== -1) {
    const firstSegment = refPart.slice(0, slashIdx);
    // A segment is a registry host if it has '.', a numeric ':port', or is 'localhost'
    const isRegistryHost =
      firstSegment.includes(".") ||
      /:\d+$/.test(firstSegment) ||
      firstSegment === "localhost";
    if (isRegistryHost) {
      registry = firstSegment;
      repoAndTag = refPart.slice(slashIdx + 1);
    } else {
      registry = "docker.io";
      repoAndTag = refPart;
    }
  } else {
    // No slash — entire refPart is 'name' or 'name:tag' on Docker Hub
    registry = "docker.io";
    repoAndTag = refPart;
  }

  // Split tag off repoAndTag: last ':' in the final path segment (never in an
  // intermediate segment since repo path segments cannot contain ':')
  let repository: string;
  let tag: string | null = null;

  const lastSlash = repoAndTag.lastIndexOf("/");
  const lastSegment =
    lastSlash !== -1 ? repoAndTag.slice(lastSlash + 1) : repoAndTag;
  const colonIdx = lastSegment.lastIndexOf(":");

  if (colonIdx !== -1) {
    const tagCandidate = lastSegment.slice(colonIdx + 1);
    if (tagCandidate) {
      tag = tagCandidate;
      repository =
        lastSlash !== -1
          ? repoAndTag.slice(0, lastSlash + 1) +
            lastSegment.slice(0, colonIdx)
          : lastSegment.slice(0, colonIdx);
    } else {
      repository = repoAndTag;
    }
  } else {
    repository = repoAndTag;
  }

  // Docker Hub single-segment repos need the 'library/' prefix for API calls
  // e.g. "postgres" → "library/postgres", "coredns/coredns" stays as-is
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  if (!REPOSITORY_RE.test(repository)) return null;

  return { raw, registry, repository, tag, digest };
}

/** True for the two ecosystems whose versions are OCI image refs ("tag@digest"). */
export function isOciEcosystem(ecosystem: string): boolean {
  return ecosystem === "docker" || ecosystem === "kubernetes";
}

/**
 * Return true when the dep's current version is an undigested (tag-only) OCI ref.
 * This is the age-gate-bypass check — pinning a mutable tag to its current digest
 * introduces no new content, so the age gate's purpose does not apply.
 * Used in BOTH the verify action and the update CLI; defined here to avoid
 * triple-duplication of the security-relevant `!current.includes("@")` predicate.
 */
export function wasUnpinnedRef(dep: { current: string }): boolean {
  return !dep.current.includes("@");
}

/**
 * Return the version portion to use for semver comparisons for a dep.
 * For OCI ecosystems the version string is "tag@digest"; we compare by tag only.
 * For all other ecosystems the version string is used directly.
 */
export function currentTagOf(dep: { ecosystem: string; current: string }): string {
  return isOciEcosystem(dep.ecosystem) ? ociTagOf(dep.current) : dep.current;
}

/** Return the tag portion of an OCI version string ("tag@sha256:..." → "tag"). */
export function ociTagOf(imageRef: string): string {
  const idx = imageRef.indexOf("@");
  return idx >= 0 ? imageRef.slice(0, idx) : imageRef;
}

/** Return the digest portion of an OCI version string, or null when absent. */
export function ociDigestOf(imageRef: string): string | null {
  const idx = imageRef.indexOf("@");
  return idx >= 0 ? imageRef.slice(idx + 1) : null;
}

/**
 * For a COPY --from / RUN --mount=from image reference (Dockerfile/Containerfile), check
 * whether the registry positively confirms the image exists. These sources are ambiguous —
 * they may name a build-stage alias, a build context, or a typo rather than a real external
 * image — so callers should only treat the result "found" as confirmed and treat every other
 * outcome ("notfound"/"unknown") as unconfirmed (skip, preferring false-negatives over
 * false-positives). Shared by the verify (`src/ecosystems/docker.ts`) and update
 * (`src/update/ecosystems/docker.ts`) Dockerfile parsers so the gate can't drift between them.
 */
export async function confirmCopyMountFromExists(
  ref: ParsedImageRef,
  dockerhubMirror: string | undefined,
): Promise<Awaited<ReturnType<typeof imageExists>>> {
  const reference = ref.digest ?? ref.tag ?? "latest";
  return imageExists(ref.registry, ref.repository, reference, dockerhubMirror);
}

export function makeName(ref: ParsedImageRef): string {
  return `${ref.registry}/${ref.repository}`;
}

export function makeVersion(ref: ParsedImageRef): string {
  if (ref.digest && ref.tag) return `${ref.tag}@${ref.digest}`;
  if (ref.digest) return ref.digest;
  if (ref.tag) return ref.tag;
  return "latest";
}

/**
 * Strip tag and digest from a raw image ref string, returning the bare registry/repo prefix.
 * e.g. "registry.example.com/repo:tag@sha256:abc" → "registry.example.com/repo"
 */
export function stripTagAndDigest(raw: string): string {
  let base = raw;
  // Remove digest (@sha256:...) first
  const digestAt = base.lastIndexOf("@");
  if (digestAt !== -1) base = base.slice(0, digestAt);
  // Remove tag from last segment (last : in the last path component after the last /)
  const lastSlash = base.lastIndexOf("/");
  const lastSegment = lastSlash !== -1 ? base.slice(lastSlash + 1) : base;
  const colonIdx = lastSegment.lastIndexOf(":");
  if (colonIdx !== -1) {
    base = base.slice(0, base.length - lastSegment.length + colonIdx);
  }
  return base;
}

/**
 * Build a replacement image ref string that preserves the author's original
 * registry/repo spelling from the raw ref, only updating the tag and digest.
 * Used by the docker and kubernetes updaters for in-place rewrites.
 */
export function buildReplacedImageRef(
  raw: string,
  newTag: string,
  newDigest: string | null,
): string {
  const base = stripTagAndDigest(raw);
  if (newDigest) return `${base}:${newTag}@${newDigest}`;
  return `${base}:${newTag}`;
}

/**
 * Resolved identity for base-vs-HEAD comparison: the concrete content a ref
 * pins to, independent of cosmetic differences in the raw string.
 * Digest-pinned images compare by `name@digest`, so a relabeled tag pointing at
 * an already-vetted digest (or a registry-spelling change) is not re-flagged.
 * Tag-only images compare by `name:tag` (the digest is unknown/mutable).
 */
export function imageIdentity(ref: ParsedImageRef): string {
  return ref.digest
    ? `${makeName(ref)}@${ref.digest}`
    : `${makeName(ref)}:${ref.tag ?? "latest"}`;
}

/**
 * Get the publish date for an image reference.
 * Only digest-pinned (@sha256:...) refs are queried — tag-only refs are
 * mutable and cannot be reliably age-gated, so they return null (unknown).
 *
 * @param ref   Parsed image ref (may be undefined for lookup-miss cases).
 * @param label Ecosystem label used in log messages (e.g. "kubernetes", "docker").
 */
export async function getImagePublishDate(
  ref: ParsedImageRef | undefined,
  label: string,
): Promise<Date | null> {
  if (!ref?.digest) {
    const key = ref
      ? `${makeName(ref)}:${ref.tag ?? "latest"}`
      : "unknown";
    const dedupKey = `${label}:${key}`;
    if (!mutableSkipLogged.has(dedupKey)) {
      mutableSkipLogged.add(dedupKey);
      core.info(
        `${label}: ${key} has no digest (mutable tag), skipping age check`,
      );
    }
    return null;
  }

  return fetchImagePublishDate(ref.registry, ref.repository, ref.digest, ref.tag);
}

/**
 * Resolve an OCI image tag to its current digest, then fetch and compute its
 * publish-date age — the full `ociDigestForTag → fetchImagePublishDate →
 * computeAgeDays` sequence shared by the verify path (latest.ts docker/k8s
 * case) and the update CLI (run.ts resolvePins).
 *
 * Returns { digest: null, publishDate: null, ageDays: null } when the digest
 * cannot be resolved (private/unreachable registry) — always fail-closed.
 */
export async function resolveImageDigestAndAge(
  registry: string,
  repository: string,
  tag: string,
  dockerhubMirror?: string,
): Promise<{ digest: string | null; publishDate: Date | null; ageDays: number | null }> {
  const digest = await ociDigestForTag(registry, repository, tag, dockerhubMirror);
  if (!digest) return { digest: null, publishDate: null, ageDays: null };
  const publishDate = await fetchImagePublishDate(registry, repository, digest, tag);
  return { digest, publishDate, ageDays: computeAgeDays(publishDate) };
}

/**
 * Given an already-resolved digest, fetch and compute its publish-date age.
 * Used by run.ts resolvePins when the digest is already available (e.g. from
 * the pre-resolved digest cache) so a second ociDigestForTag call is not needed.
 * `fetchImagePublishDate → computeAgeDays` is the shared sub-sequence.
 */
export async function fetchImageAgeFromDigest(
  registry: string,
  repository: string,
  digest: string,
  tag: string | null,
): Promise<{ publishDate: Date | null; ageDays: number | null }> {
  const publishDate = await fetchImagePublishDate(registry, repository, digest, tag);
  return { publishDate, ageDays: computeAgeDays(publishDate) };
}
