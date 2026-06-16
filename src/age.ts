const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the age of a publish date in whole days from now.
 * Returns null if publishDate is null or an invalid Date.
 */
export function computeAgeDays(publishDate: Date | null): number | null {
  if (!publishDate || isNaN(publishDate.getTime())) return null;
  return Math.floor((Date.now() - publishDate.getTime()) / DAY_MS);
}

/**
 * Single shared age-gate predicate used by BOTH the verify action and the
 * update CLI. Fail-closed: a null age (unconfirmable publish date) is treated
 * as NOT meeting the gate, so neither path can promote an unverifiable version.
 */
export function meetsMinAge(ageDays: number | null, minAgeDays: number): boolean {
  return ageDays !== null && ageDays >= minAgeDays;
}
