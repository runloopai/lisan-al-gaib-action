import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import { fetchImagePublishDate } from "../registry.js";
import type { ChangedDep, ParsedImageRef } from "./types.js";

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

  // Split off digest (everything after the last '@')
  const atIdx = trimmed.lastIndexOf("@");
  let digest: string | null = null;
  let refPart: string;
  if (atIdx !== -1) {
    digest = trimmed.slice(atIdx + 1) || null;
    refPart = trimmed.slice(0, atIdx);
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

/** Recursively walk a parsed YAML value and collect container image strings. */
function extractImages(
  obj: unknown,
  out: Map<string, ParsedImageRef>,
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractImages(item, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (
      key === "containers" ||
      key === "initContainers" ||
      key === "ephemeralContainers"
    ) {
      const arr = rec[key];
      if (Array.isArray(arr)) {
        for (const container of arr) {
          if (
            container &&
            typeof container === "object" &&
            !Array.isArray(container)
          ) {
            const imageStr = (container as Record<string, unknown>).image;
            if (typeof imageStr === "string") {
              const ref = parseImageRef(imageStr);
              if (ref) out.set(imageStr, ref);
            }
          }
        }
      }
    } else {
      extractImages(rec[key], out);
    }
  }
}

/**
 * Parse a rendered Kubernetes manifest (possibly multi-document YAML with '---'
 * separators) and return a map of raw image strings to parsed refs.
 *
 * Works across all workload kinds by recursively finding containers/
 * initContainers/ephemeralContainers arrays anywhere in the document tree —
 * handles Deployment, StatefulSet, DaemonSet, Job, CronJob (nested), Pod,
 * and CRDs like Argo Rollouts without hard-coding kinds.
 */
export function parseManifestImages(
  content: string,
): Map<string, ParsedImageRef> {
  const refs = new Map<string, ParsedImageRef>();
  try {
    yaml.loadAll(content, (doc) => {
      try {
        extractImages(doc, refs);
      } catch {
        // skip individual malformed documents
      }
    });
  } catch {
    // invalid YAML — return whatever was collected before the error
  }
  return refs;
}

function makeName(ref: ParsedImageRef): string {
  return `${ref.registry}/${ref.repository}`;
}

function makeVersion(ref: ParsedImageRef): string {
  if (ref.digest && ref.tag) return `${ref.tag}@${ref.digest}`;
  if (ref.digest) return ref.digest;
  if (ref.tag) return ref.tag;
  return "latest";
}

export async function getChangedDeps(
  baseRef: string,
  kubernetesFilesInput: string,
): Promise<{ deps: ChangedDep[]; imageRefs: Map<string, ParsedImageRef> }> {
  let files: string[];

  if (kubernetesFilesInput) {
    const allFiles = new Set(await resolveFiles(kubernetesFilesInput));
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter((f) => allFiles.has(f));
  } else {
    // Auto-detect: any changed .yaml/.yml file that contains workload manifests
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    );
  }

  if (files.length === 0) {
    core.info("kubernetes: no changed YAML files");
    return { deps: [], imageRefs: new Map() };
  }

  const allDeps: ChangedDep[] = [];
  const imageRefs = new Map<string, ParsedImageRef>();

  for (const file of files) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) continue;

    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`kubernetes: could not read ${file}`);
      continue;
    }

    const headRefs = parseManifestImages(headContent);
    if (headRefs.size === 0) continue; // not a manifest with containers

    const baseContent = await gitShowFile(baseRef, file);
    const baseRefs = baseContent
      ? parseManifestImages(baseContent)
      : new Map<string, ParsedImageRef>();

    for (const [rawImage, ref] of headRefs) {
      if (baseRefs.has(rawImage)) continue; // unchanged

      const name = makeName(ref);
      const version = makeVersion(ref);
      imageRefs.set(`${name}@${version}`, ref);

      allDeps.push({
        ecosystem: "kubernetes",
        name,
        version,
        file,
      });
    }
  }

  return { deps: allDeps, imageRefs };
}

/**
 * Get the publish date for an image reference.
 * Only digest-pinned (@sha256:...) refs are queried — tag-only refs are
 * mutable and cannot be reliably age-gated, so they return null (unknown).
 */
export async function getPublishDate(
  ref: ParsedImageRef | undefined,
): Promise<Date | null> {
  if (!ref?.digest) {
    const key = ref
      ? `${makeName(ref)}:${ref.tag ?? "latest"}`
      : "unknown";
    if (!mutableSkipLogged.has(key)) {
      mutableSkipLogged.add(key);
      core.info(
        `kubernetes: ${key} has no digest (mutable tag), skipping age check`,
      );
    }
    return null;
  }

  return fetchImagePublishDate(ref.registry, ref.repository, ref.digest, ref.tag);
}
