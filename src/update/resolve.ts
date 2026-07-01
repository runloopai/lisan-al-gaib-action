import * as core from "@actions/core";
import { runBatched } from "../concurrency.js";

/** Maximum number of concurrent registry/network tasks per batch. */
export const RESOLVE_CONCURRENCY = 8;

/**
 * Deduplicate deps by cache key, then batch-resolve each unique dep using `resolveOne`.
 * Returns a Map<cacheKey, T | null> where null means resolution threw.
 * Concurrency-bounded by `runBatched`.
 *
 * This module is intentionally a leaf (imports only `runBatched`) so it can be
 * imported from `src/main.ts` without pulling in the clack TUI or any updater
 * ecosystem module into the action bundle.
 *
 * @param logger Optional callback for per-dep resolve failures; defaults to `core.info`
 * (the interactive updater's quieter default). The verify action passes `core.warning`
 * so a failed registry lookup surfaces as a GitHub annotation instead of debug-only output.
 */
export async function dedupeAndResolve<D, T>(
  deps: D[],
  keyOf: (dep: D) => string,
  resolveOne: (dep: D) => Promise<T>,
  concurrency: number,
  logger?: (message: string) => void,
): Promise<Map<string, T | null>> {
  const log = logger ?? ((msg) => core.info(msg));
  const unique = new Map<string, D>();
  for (const dep of deps) {
    const key = keyOf(dep);
    if (!unique.has(key)) unique.set(key, dep);
  }
  const result = new Map<string, T | null>();
  await runBatched(
    [...unique.entries()].map(([key, dep]) => async () => {
      try {
        result.set(key, await resolveOne(dep));
      } catch (err) {
        log(`[lisan] resolve failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
        result.set(key, null);
      }
    }),
    concurrency,
  );
  return result;
}
