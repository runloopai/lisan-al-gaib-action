import * as core from "@actions/core";
import { extractBazelDeps, extractOverrides } from "../../bazel.js";
import type { BazelDep, BazelOverride } from "../../ecosystems/types.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";
import { type BazelVersionPosition, buildBazelVersionEdits, rewriteKeyOf } from "./bazel-shared.js";
export { rewriteKeyOf };
import { readModuleFilesSafe } from "./shared.js";

/**
 * Pure helper: given parsed per-file bazel_dep and override data, decide which
 * DepRefs to emit.  Extracted so it can be unit-tested without fs/git.
 *
 * Rules:
 * - git / archive / local_path / multiple_version override → skip the bazel_dep
 *   (the version is ignored or meaningless at the registry level).
 * - single_version_override with version= → skip the bazel_dep, redirect the DepRef
 *   to point at the override's version literal (what Bazel actually uses).
 *   Only emitted when the module also has an explicit bazel_dep in the file tree —
 *   purely transitive overrides (no bazel_dep) are not proposed for update.
 * - single_version_override without version= (registry-only pin) → the bazel_dep
 *   version is still effective; emit normally.
 * - no override → emit normally.
 */
export function selectBazelDepRefs(
  parsed: Array<{ file: string; bazelDeps: BazelDep[]; overrides: Map<string, BazelOverride> }>,
): DepRef[] {
  // Collect all overrides first (later file wins, matching checker behaviour).
  // Track the source file alongside each override so the redirect DepRef can
  // point at the right file for byte-offset rewrites.
  const overrides = new Map<string, { override: BazelOverride; file: string }>();
  for (const { file, overrides: fileOverrides } of parsed) {
    for (const [name, override] of fileOverrides) {
      overrides.set(name, { override, file });
    }
  }

  const deps: DepRef[] = [];
  // Track modules that have an explicit bazel_dep declaration so the redirect
  // pass only bumps directly-declared deps (not purely transitive overrides).
  const directDepNames = new Set<string>();

  // bazel_dep pass — emit or skip based on override type.
  for (const { file, bazelDeps } of parsed) {
    for (const dep of bazelDeps) {
      if (!dep.versionRef) continue;

      directDepNames.add(dep.name);

      // Read-only refs (e.g. CONST.rpartition(".")[0]) are resolved for age-gating by
      // the checker but must not be rewritten — the constant is driven by a sibling ref.
      if (dep.versionRef.readOnly) continue;

      const entry = overrides.get(dep.name);
      if (entry) {
        const { override } = entry;
        if (
          override.type === "local_path" ||
          override.type === "git" ||
          override.type === "archive" ||
          override.type === "multiple_version"
        ) {
          core.warning(
            `bazel: skipping ${dep.name} bazel_dep (governed by ${override.type}_override — version literal is not used by Bazel)`,
          );
          continue;
        }
        if (override.type === "single_version" && override.version != null) {
          // Redirect handled in the single_version pass below.
          continue;
        }
        // single_version without version= (registry-only pin) — fall through to emit.
      }

      const position: BazelVersionPosition = { versionRef: dep.versionRef, file };
      deps.push({
        ecosystem: "bazel",
        name: dep.name,
        file,
        current: dep.version,
        position,
      });
    }
  }

  // single_version redirect pass — emit a DepRef pointing at the override's own
  // version literal, which is the version Bazel actually resolves.
  // Only emit for modules that have an explicit bazel_dep declaration — skip
  // purely transitive overrides (no bazel_dep in the file tree) to avoid
  // proposing unsolicited bumps of intentionally-pinned transitive deps.
  for (const [name, { override, file: overrideFile }] of overrides) {
    // Skip read-only versionRefs (e.g. CONST.rpartition(".")[0]) — the override
    // version is driven by a sibling ref; no update should be proposed here either.
    if (
      override.type === "single_version" &&
      override.versionRef &&
      !override.versionRef.readOnly &&
      override.version != null &&
      directDepNames.has(name)
    ) {
      const position: BazelVersionPosition = {
        versionRef: override.versionRef,
        file: overrideFile,
      };
      deps.push({
        ecosystem: "bazel",
        name,
        file: overrideFile,
        current: override.version,
        position,
      });
    }
  }

  return deps;
}

export async function discover(opts: {
  moduleBazel?: string;
}): Promise<DepRef[]> {
  const moduleBazelPath = opts.moduleBazel ?? "MODULE.bazel";
  const fileContents = await readModuleFilesSafe(moduleBazelPath, "bazel");

  const parsed: Array<{ file: string; bazelDeps: BazelDep[]; overrides: Map<string, BazelOverride> }> = [];

  for (const { file, content } of fileContents) {
    let bazelDeps: BazelDep[];
    try {
      bazelDeps = await extractBazelDeps(content);
    } catch {
      // Skip the whole file on parse failure so a broken file cannot contribute
      // overrides that suppress valid dep updates from other files.
      console.warn(`bazel: failed to parse bazel_dep calls from ${file}, skipping`);
      continue;
    }

    let fileOverrides: Map<string, BazelOverride>;
    try {
      fileOverrides = await extractOverrides(content);
    } catch {
      console.warn(`bazel: failed to parse overrides from ${file}`);
      fileOverrides = new Map();
    }

    parsed.push({ file, bazelDeps, overrides: fileOverrides });
  }

  return selectBazelDepRefs(parsed);
}

export async function buildFileEdits(
  candidates: UpdateCandidate[],
  style: UpdateStyle,
): Promise<FileEdit[]> {
  void style; // semver-only ecosystem; style (sha vs preserve) does not apply
  return buildBazelVersionEdits(candidates);
}
