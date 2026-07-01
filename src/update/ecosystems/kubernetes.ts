import * as core from "@actions/core";
import { parseManifestImagesWithPositions } from "../../ecosystems/kubernetes.js";
import { makeName, makeVersion, buildReplacedImageRef } from "../../ecosystems/image.js";
import { lineStartOffsets, groupByFile, readFilesSafe, discoverViaGlobs, DEFAULT_GLOB_EXCLUSIONS } from "./shared.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";

export interface K8sPosition {
  raw: string;
  absoluteOffset: number;  // absolute UTF-16 code-unit offset of image ref in file content
  refLength: number;       // UTF-16 code-unit length of image ref string
  registry: string;
  repository: string;
  tag: string | null;
  digest: string | null;
  expected: string;        // verbatim bytes at [absoluteOffset, absoluteOffset+refLength) for stale-offset guard
  file: string;
}

// Single multiline pattern string passed to a single glob.create() call so that
// the !-prefixed exclusions apply globally across both positive patterns.
// DEFAULT_GLOB_EXCLUSIONS is imported from shared.ts (single source of truth).
const DEFAULT_KUBERNETES_GLOB_PATTERN = [
  "**/*.yaml",
  "**/*.yml",
  ...DEFAULT_GLOB_EXCLUSIONS,
].join("\n");

export async function discover(opts: {
  kubernetesFiles?: string;
}): Promise<DepRef[]> {
  const files = await discoverViaGlobs({
    inputGlob: opts.kubernetesFiles,
    defaultPattern: DEFAULT_KUBERNETES_GLOB_PATTERN,
    label: "kubernetes",
  });

  const deps: DepRef[] = [];

  for (const { file, content } of await readFilesSafe(files, "kubernetes")) {
    let refs;
    try {
      refs = parseManifestImagesWithPositions(content, file);
    } catch {
      // Not a valid manifest, skip
      continue;
    }
    // Note: parseManifestImagesWithPositions (../../ecosystems/kubernetes.ts) fails safe for
    // images the semantic YAML parse found but the line-scan positioner couldn't locate
    // (flow-style `{image: ...}` or YAML anchors/aliases) — those never appear in `refs` at
    // all, so they are silently absent here rather than mis-rewritten. That module emits a
    // core.warning for the dropped images, which today is Actions-log/stderr-only; there is
    // no per-dep note/warning channel on DepRef to relay it into the CLI's own summary output
    // without adding new cross-file plumbing (types.ts/run.ts), so it is left as-is.

    // Pre-compute per-line start offsets for converting line+char to absolute offset
    const lineStarts = lineStartOffsets(content);

    for (const item of refs) {
      if (item.ref === null) continue;

      const absoluteOffset = lineStarts[item.lineIndex] + item.valueOffset;
      const refLength = item.valueLength;

      // Defense-in-depth: verify the computed offset actually points at the
      // raw image string the parser returned — mirrors docker.ts:73's guard.
      // A mismatch means the line-start + valueOffset arithmetic diverged from
      // the YAML parser's view of the scalar, so we skip rather than risk a
      // wrong-offset rewrite later (the stale-offset check in apply.ts would
      // also catch it at apply time, but this provides earlier visibility).
      if (content.slice(absoluteOffset, absoluteOffset + refLength) !== item.raw) {
        core.info(
          `[lisan] kubernetes: skipping ${item.raw} in ${file} — ` +
          `computed offset does not match raw image string; manual update required`,
        );
        continue;
      }

      const position: K8sPosition = {
        raw: item.raw,
        absoluteOffset,
        refLength,
        registry: item.ref.registry,
        repository: item.ref.repository,
        tag: item.ref.tag,
        digest: item.ref.digest,
        expected: content.slice(absoluteOffset, absoluteOffset + refLength),
        file,
      };

      deps.push({
        ecosystem: "kubernetes",
        name: makeName(item.ref),
        file,
        current: makeVersion(item.ref),
        position,
      });
    }
  }

  return deps;
}

/**
 * Return the composite `"offset:length"` key for the OffsetRewrite that
 * `buildFileEdits` will emit for this candidate, or undefined when the
 * position data is missing or malformed.
 *
 * Matches `${rw.offset}:${rw.length}` produced by `buildFileEdits`:
 *   offset = absoluteOffset, length = refLength
 */
export function rewriteKeyOf(candidate: UpdateCandidate): string | undefined {
  const pos = candidate.dep.position as K8sPosition | null | undefined;
  if (!pos || typeof pos.absoluteOffset !== "number") return undefined;
  return `${pos.absoluteOffset}:${pos.refLength}`;
}

export function buildFileEdits(
  candidates: UpdateCandidate[],
  style: UpdateStyle,
): FileEdit[] {
  void style; // images are always digest-pinned now; sha/preserve distinction does not apply

  const byFile = groupByFile(candidates);

  const edits: FileEdit[] = [];

  for (const [file, fileCandidates] of byFile) {
    const rewrites: FileEdit["rewrites"] = [];

    for (const candidate of fileCandidates) {
      const pos = candidate.dep.position as K8sPosition;

      if (!candidate.pinnedTo) {
        // No digest could be resolved — never write a mutable ref. Skip with a warning.
        core.warning(
          `[lisan] kubernetes: skipping ${pos.raw} — could not resolve digest for ` +
          `${candidate.dep.name}:${candidate.latest}; not writing a bare-tag ref`,
        );
        continue;
      }

      // Always pin: repo:tag@digest
      const replace = buildReplacedImageRef(pos.raw, candidate.latest, candidate.pinnedTo);
      rewrites.push({ offset: pos.absoluteOffset, length: pos.refLength, replace, expected: pos.expected });
    }

    if (rewrites.length > 0) {
      edits.push({ file, rewrites });
    }
  }

  return edits;
}
