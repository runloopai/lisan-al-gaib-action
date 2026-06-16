import * as fs from "node:fs/promises";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "./types.js";

import * as actionsUpdater from "./ecosystems/actions.js";
import * as dockerUpdater from "./ecosystems/docker.js";
import * as kubernetesUpdater from "./ecosystems/kubernetes.js";
import * as rustUpdater from "./ecosystems/rust.js";
import * as javaUpdater from "./ecosystems/java.js";
import * as bazelUpdater from "./ecosystems/bazel.js";
import { ECOSYSTEM_REGISTRY } from "./ecosystem-registry.js";
import type { RunOpts } from "./run.js";

export const STARLARK_ECOSYSTEMS = new Set(
  Object.entries(ECOSYSTEM_REGISTRY).filter(([, v]) => v.isStarlark).map(([k]) => k),
);

export type EcosystemDispatch = {
  discover: (opts: RunOpts) => Promise<DepRef[]>;
  buildFileEdits: (candidates: UpdateCandidate[], style: UpdateStyle) => FileEdit[] | Promise<FileEdit[]>;
  /**
   * Return the `"offset:length"` key identifying the OffsetRewrite this candidate
   * will produce, or undefined for string-rewrite candidates (e.g. Java artifactRaw)
   * and when position data is malformed. Must agree exactly with the key produced by
   * `buildFileEdits` so the attribution pass in `attributeRewrites` stays in sync.
   */
  rewriteKeyOf: (candidate: UpdateCandidate) => string | undefined;
};

/** Single source of truth for discover/buildFileEdits/rewriteKeyOf dispatch. */
export const ECOSYSTEM_DISPATCH: Record<string, EcosystemDispatch> = {
  actions:    {
    discover:       (opts) => actionsUpdater.discover({ workflowFiles: opts.workflowFiles, token: opts.token }),
    buildFileEdits:  (c, s) => actionsUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => actionsUpdater.rewriteKeyOf(c),
  },
  docker:     {
    discover:       (opts) => dockerUpdater.discover({ dockerfiles: opts.dockerfiles, dockerhubMirror: opts.dockerhubMirror }),
    buildFileEdits:  (c, s) => dockerUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => dockerUpdater.rewriteKeyOf(c),
  },
  kubernetes: {
    discover:       (opts) => kubernetesUpdater.discover({ kubernetesFiles: opts.kubernetesFiles }),
    buildFileEdits:  (c, s) => kubernetesUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => kubernetesUpdater.rewriteKeyOf(c),
  },
  rust:       {
    discover:       (opts) => rustUpdater.discover({ moduleBazel: opts.moduleBazel }),
    buildFileEdits:  (c, s) => rustUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => rustUpdater.rewriteKeyOf(c),
  },
  java:       {
    discover:       (opts) => javaUpdater.discover({ moduleBazel: opts.moduleBazel }),
    buildFileEdits:  (c, s) => javaUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => javaUpdater.rewriteKeyOf(c),
  },
  bazel:      {
    discover:       (opts) => bazelUpdater.discover({ moduleBazel: opts.moduleBazel }),
    buildFileEdits:  (c, s) => bazelUpdater.buildFileEdits(c, s),
    rewriteKeyOf:    (c) => bazelUpdater.rewriteKeyOf(c),
  },
} satisfies Record<keyof typeof ECOSYSTEM_REGISTRY, EcosystemDispatch>;

/** Read a dep/candidate's versionRef position (java + rust + bazel share this shape). */
export function versionRefOf(dep: DepRef): { nodeStart: number; nodeEnd: number; constantName?: string; templatePrefix: string; templateSuffix: string; readOnly?: boolean } | null {
  const pos = dep.position as { versionRef?: { nodeStart: number; nodeEnd: number; constantName?: string; templatePrefix: string; templateSuffix: string; readOnly?: boolean } } | undefined;
  return pos?.versionRef ?? null;
}

/**
 * Stable cache key for a dep that points at a Starlark constant literal.
 * Pass `realpaths` to collapse symlink aliases to the same physical file — without it,
 * two path aliases to the same MODULE.bazel produce different keys (narrow edge case).
 */
export function constantKeyOf(dep: DepRef, realpaths?: Map<string, string>): string | null {
  const vr = versionRefOf(dep);
  if (!vr) return null;
  const file = realpaths?.get(dep.file) ?? dep.file;
  return `${file}::${vr.nodeStart}::${vr.nodeEnd}`;
}

/**
 * Return a composite `"offset:length"` key identifying the OffsetRewrite a candidate
 * will produce, or undefined when the candidate uses a StringRewrite or has an unknown
 * position type.
 *
 * Delegates to the per-ecosystem `rewriteKeyOf` exported by each ecosystem module and
 * wired into `ECOSYSTEM_DISPATCH`. Centralising the formula there (co-located with
 * `buildFileEdits`) ensures the attribution key never drifts from the actual rewrite
 * produced: any length-formula change in `buildFileEdits` is immediately reflected here.
 *
 * Keying on `"offset:length"` rather than just `offset` prevents a narrow but real
 * misattribution: two candidates whose OffsetRewrites happen to share the same start
 * offset but different lengths (e.g. a dropped constant rewrite and an unrelated rewrite
 * at the same position in the same file) would both match a bare-offset check, giving the
 * dropped candidate a false "produced an edit" attribution.  The composite key is unique
 * per distinct byte range and matches the key used by `reconcileConstantRewrites` when
 * grouping rewrites — so a dropped group produces no composite key in the surviving set
 * and is correctly demoted to noEdits.
 */
export function expectedOffsetKeyOf(candidate: UpdateCandidate): string | undefined {
  return ECOSYSTEM_DISPATCH[candidate.dep.ecosystem]?.rewriteKeyOf(candidate);
}

/**
 * Return the StringRewrite search string for a candidate that uses string-based
 * rewrites, or undefined when offset-based (or unknown). Currently only Java
 * inline literal coordinates (no versionRef) use StringRewrites.
 */
export function expectedSearchStringOf(candidate: UpdateCandidate): string | undefined {
  if (candidate.dep.ecosystem !== "java") return undefined;
  const pos = candidate.dep.position as { artifactRaw?: unknown } | null | undefined;
  const raw = pos?.artifactRaw;
  return typeof raw === "string" ? raw : undefined;
}

/** Resolve a file's realpath, falling back to the given path itself if the syscall fails
 * (e.g. the file doesn't exist yet, or a permissions issue) — realpath resolution is an
 * optimization for collapsing symlink aliases, not a correctness requirement. */
export async function realpathOr(file: string): Promise<string> {
  return fs.realpath(file).catch(() => file);
}

/**
 * Resolve filesystem realpaths for all Starlark-ecosystem dep files.
 * Shared by run() and reconcileConstantGroups so both use identical keys.
 * Only Starlark deps are processed; non-Starlark entries are ignored.
 */
export async function resolveDepRealpaths(deps: DepRef[]): Promise<Map<string, string>> {
  const depRealpaths = new Map<string, string>();
  await Promise.all(
    deps
      .filter((d) => STARLARK_ECOSYSTEMS.has(d.ecosystem))
      .map(async (d) => {
        if (!depRealpaths.has(d.file)) {
          depRealpaths.set(d.file, await realpathOr(d.file));
        }
      }),
  );
  return depRealpaths;
}
