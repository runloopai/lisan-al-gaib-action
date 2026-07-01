/**
 * Returns true when an originally-unpinned OCI image should bypass the age gate.
 * Pinning a mutable tag to its current digest introduces no new content — it
 * freezes what the user is already running — so the age gate's purpose does not
 * apply. Already-pinned images (wasUnpinned=false) stay fail-closed regardless.
 */
export function shouldBypassAgeGate(wasUnpinned: boolean, pinUnpinned: boolean): boolean {
  return pinUnpinned && wasUnpinned;
}

/**
 * Format the age-gate failure clause shown in skip/warning messages.
 * Returns e.g. "14d old (< 28d min-age)" or "publish date unconfirmable".
 */
export function formatAgeClause(ageDays: number | null, minAgeDays: number): string {
  return ageDays !== null
    ? `${ageDays}d old (< ${minAgeDays}d min-age)`
    : "publish date unconfirmable";
}
