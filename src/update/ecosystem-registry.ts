/**
 * Ecosystem registry — pure metadata, no heavy imports.
 *
 * This is the single source of truth for which ecosystems the updater supports
 * and their structural metadata. The actual updater implementations live in
 * src/update/ecosystems/*.ts and are imported only from run.ts (which owns the
 * dispatch switch statements).
 */

/** Minimal metadata needed for run.ts table-driven dispatch. */
export interface UpdaterEcosystem {
  /** Whether this ecosystem's lockfile is Starlark (MODULE.bazel-based). */
  isStarlark: boolean;
}

export const ECOSYSTEM_REGISTRY = {
  actions:    { isStarlark: false },
  docker:     { isStarlark: false },
  kubernetes: { isStarlark: false },
  rust:       { isStarlark: true },
  java:       { isStarlark: true },
  bazel:      { isStarlark: true },
} satisfies Record<string, UpdaterEcosystem>;

export const SUPPORTED_ECOSYSTEMS = new Set(Object.keys(ECOSYSTEM_REGISTRY));
