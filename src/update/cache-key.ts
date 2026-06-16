/**
 * Stable cache-key for a (ecosystem, name, current) tuple.
 *
 * Uses ||| as separator because it cannot appear in any ecosystem name,
 * OCI image name (which may contain ":" and "@"), version string, or SHA.
 * Using ":" or "@" as a separator would produce collisions for OCI images
 * whose versions are of the form "tag@sha256:…".
 *
 * This module has NO imports so it can be safely imported from both
 * src/main.ts (action bundle) and src/update/run.ts (CLI bundle)
 * without dragging clack or other CLI-only deps into the action bundle.
 */
export function resolveCacheKey(ecosystem: string, name: string, current: string): string {
  return `${ecosystem}|||${name}|||${current}`;
}
