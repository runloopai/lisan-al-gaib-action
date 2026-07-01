/**
 * Ecosystems supported by the update CLI. Kept in a leaf module so the verify
 * action can import this set without pulling in the rest of the updater.
 *
 * Re-exported from ecosystem-registry.ts, which is the single source of truth.
 */
export { SUPPORTED_ECOSYSTEMS } from "./ecosystem-registry.js";
