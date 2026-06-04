import * as core from "@actions/core";
import { fetchImagePublishDate } from "../registry.js";
import type { ParsedImageRef } from "./types.js";

const mutableSkipLogged = new Set<string>();

/**
 * Parse an OCI/Docker image reference string into its components.
 *
 * Grammar: [registry[:port]/]repository[:tag][@digest]
 * Registry detection: first path segment is a host if it contains '.' or a
 * numeric port suffix (':' + all-digits) or equals 'localhost'. Otherwise the
 * image is on Docker Hub. Single-segment Docker Hub repos are normalized to
 * library/<name> so API lookups work (e.g. "postgres" → "library/postgres").
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

  return { raw, registry, repository, tag, digest };
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
