import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import type { ChangedDep, ParsedImageRef } from "./types.js";
import { parseImageRef, makeName, makeVersion, getImagePublishDate } from "./image.js";

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

    // No imageExists gate here: k8s manifest `image:` fields are unambiguous real
    // image references (unlike docker COPY --from which can be a build-context alias).
    // parseImageRef already drops invalid names (placeholders, uppercase, etc.).
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
  return getImagePublishDate(ref, "kubernetes");
}
