import * as clack from "@clack/prompts";
import { isOciEcosystem, wasUnpinnedRef } from "../ecosystems/image.js";
import { pickSemverMin } from "./ecosystems/bazel-shared.js";
import { versionRefOf, constantKeyOf } from "./dispatch.js";
import type { UpdateCandidate } from "./types.js";

/** Thrown when the user cancels the interactive prompt — callers should exit 0, not 1. */
export class UserCancelledError extends Error {
  constructor() { super("Cancelled."); this.name = "UserCancelledError"; }
}

/** Option shape passed to @clack/prompts groupMultiselect — value is always an array. */
type SelectionOption = { value: UpdateCandidate[]; label: string; hint?: string };

/**
 * Build the option groups for the interactive multi-select prompt.
 *
 * Candidates that share a Starlark constant (same `constantKeyOf`) and have 2 or
 * more members are collapsed into a single checkbox row — toggling it on/off
 * selects/deselects all members atomically, which matches how the backend rewrites
 * them (they share the same literal byte range in the file). Candidates with a
 * null key (non-Starlark deps, inline literals) or whose constant is unique to
 * them appear as individual rows, each wrapped in a one-element array.
 *
 * The options within each ecosystem group are emitted in the same order as
 * `applyableCandidates`, with each collapsed group placed at the position of its
 * first member.
 */
export function buildSelectionGroups(
  applyableCandidates: UpdateCandidate[],
  depRealpaths?: Map<string, string>,
): Record<string, SelectionOption[]> {
  // First pass: count members per constant key so we know which are shared (2+).
  const constantMemberCounts = new Map<string, number>();
  for (const c of applyableCandidates) {
    const key = constantKeyOf(c.dep, depRealpaths);
    if (key !== null) {
      constantMemberCounts.set(key, (constantMemberCounts.get(key) ?? 0) + 1);
    }
  }

  // Collect all members for each shared constant (preserving order for the hint).
  const constantGroupMembers = new Map<string, UpdateCandidate[]>();
  for (const c of applyableCandidates) {
    const key = constantKeyOf(c.dep, depRealpaths);
    if (key !== null && constantMemberCounts.get(key)! >= 2) {
      const members = constantGroupMembers.get(key);
      if (!members) { constantGroupMembers.set(key, [c]); } else { members.push(c); }
    }
  }

  const groups: Record<string, SelectionOption[]> = {};
  const addToGroup = (eco: string, item: SelectionOption) => {
    if (!groups[eco]) groups[eco] = [];
    groups[eco].push(item);
  };

  // Second pass: emit rows in input order; collapsed groups appear at their first member.
  const emittedConstantKeys = new Set<string>();
  for (const c of applyableCandidates) {
    const key = constantKeyOf(c.dep, depRealpaths);
    const isShared = key !== null && constantMemberCounts.get(key)! >= 2;

    if (isShared) {
      if (emittedConstantKeys.has(key!)) continue; // subsequent members: already emitted
      emittedConstantKeys.add(key!);

      const members = constantGroupMembers.get(key!)!;
      // The version actually written is the semver-minimum (same rule as reconcileConstantRewrites).
      // Display it so the label is truthful about what will be written.
      const representative = pickSemverMin(members, (m) => m.latest) ?? members[0];
      const proposed = representative.latest;
      const eco = representative.dep.ecosystem;
      const file = representative.dep.file;
      const vr = versionRefOf(representative.dep);
      const constName = vr?.constantName ?? `${file}:${vr?.nodeStart ?? key}`;

      const anyBreaking = members.some((m) => m.breaking);
      const anyLicenseRegresses = members.some((m) => m.licenseRegresses);
      const breakingLabel = anyBreaking ? " ⚠ breaking" : "";
      const licenseLabel = anyLicenseRegresses ? " ⚠ license regresses" : "";

      addToGroup(eco, {
        value: members,
        label: `${constName} → ${proposed} (${members.length} packages)${breakingLabel}${licenseLabel}`,
        hint: `${file} — ${members.map((m) => m.dep.name).join(", ")}`,
      });
    } else {
      // Singleton row: same presentation as before, wrapped in a one-element array.
      const eco = c.dep.ecosystem;
      const isPinInPlace =
        isOciEcosystem(eco) && wasUnpinnedRef(c.dep);
      const breakingLabel = isPinInPlace ? " (pin)" : c.breaking ? " ⚠ breaking" : "";
      const licenseLabel = c.licenseRegresses
        ? ` ⚠ license: ${c.licenseCurrent} → ${c.licenseNew}`
        : "";
      const age = c.ageDays != null ? ` (${c.ageDays}d old)` : "";
      addToGroup(eco, {
        value: [c],
        label: `${c.dep.name}: ${c.dep.current} → ${c.latest}${breakingLabel}${licenseLabel}`,
        hint: `${c.dep.file}${age}`,
      });
    }
  }

  return groups;
}

/**
 * Present an interactive multi-select prompt for the applyable candidates and
 * return the user's selection. Throws UserCancelledError when the user cancels.
 */
export async function selectCandidates(
  applyableCandidates: UpdateCandidate[],
  depRealpaths?: Map<string, string>,
): Promise<UpdateCandidate[]> {
  if (applyableCandidates.length === 0) return [];

  const groups = buildSelectionGroups(applyableCandidates, depRealpaths);

  const result = await clack.groupMultiselect<UpdateCandidate[]>({
    message: "Select updates to apply",
    options: groups,
    required: false,
  });

  if (clack.isCancel(result)) {
    clack.cancel("Cancelled.");
    throw new UserCancelledError();
  }

  // Each option value is UpdateCandidate[] (singleton or collapsed group); flatten to a flat list.
  return (result as UpdateCandidate[][]).flat();
}
