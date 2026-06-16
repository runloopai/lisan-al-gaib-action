import * as core from "@actions/core";
import * as path from "node:path";
import { extractMavenInstalls, extractMavenArtifacts } from "../../bazel.js";
import type { VersionRef } from "../../ecosystems/types.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";
import { buildConstantEditsForFile, readFileForConstantEdits, rewriteKeyOf } from "./bazel-shared.js";
export { rewriteKeyOf };
import { groupByFile, readModuleFilesSafe } from "./shared.js";

/**
 * Position for a Maven artifact dependency:
 * - Inline-literal coord (e.g. `"group:artifact:1.2.3"` in artifacts= list):
 *   `artifactRaw` is set → string-replace the old coord with the new coord.
 * - Constant/interpolated version (coord `%s` template or maven.artifact() version kwarg):
 *   `versionRef` is set → offset-based rewrite of the constant's value literal.
 * Exactly one of the two is always set.
 */
export interface JavaArtifactPosition {
  file: string;
  artifactRaw?: string;
  versionRef?: VersionRef;
}

export async function discover(opts: {
  moduleBazel?: string;
}): Promise<DepRef[]> {
  const moduleBazelPath = opts.moduleBazel ?? "MODULE.bazel";
  const workspaceRoot = path.resolve(path.dirname(moduleBazelPath));
  const fileContents = await readModuleFilesSafe(moduleBazelPath, "java");

  const deps: DepRef[] = [];

  for (const { file, content } of fileContents) {
    // --- maven.install() artifacts= list entries ---
    let installs;
    try {
      installs = await extractMavenInstalls(content, workspaceRoot);
    } catch {
      console.warn(`java: failed to parse maven installs from ${file}`);
      continue;
    }

    for (const install of installs) {
      for (const artifact of install.artifacts) {
        // Maven coords in Bazel maven.install are always group:artifact:version (3 segments).
        // 4/5-segment forms with explicit packaging or classifier are not supported.
        const parts = artifact.coord.split(":");
        if (parts.length !== 3) continue;

        const groupId = parts[0];
        const artifactId = parts[1];
        const version = artifact.versionRef?.value ?? parts[2];

        if (!groupId || !artifactId || !version) continue;

        if (artifact.versionRef) {
          // Read-only refs (e.g. CONST.rpartition(".")[0]) are resolved for age-gating by
          // the checker but must not be rewritten — skip so we don't attempt a write-back
          // through a lossy transform, and don't fall into the inline-literal string-replace
          // branch (the coord template doesn't appear literally in the file).
          if (artifact.versionRef.readOnly) continue;
          // Constant/interpolated version — use offset-based rewrite
          deps.push({
            ecosystem: "java",
            name: `${groupId}:${artifactId}`,
            file,
            current: version,
            position: { file, versionRef: artifact.versionRef } satisfies JavaArtifactPosition,
            repositories: install.repositories.length > 0 ? install.repositories : undefined,
          });
        } else {
          // Inline literal coord — use string-replace
          deps.push({
            ecosystem: "java",
            name: `${groupId}:${artifactId}`,
            file,
            current: parts[2],
            position: { file, artifactRaw: artifact.coord } satisfies JavaArtifactPosition,
            repositories: install.repositories.length > 0 ? install.repositories : undefined,
          });
        }
      }
    }

    // --- standalone maven.artifact() calls ---
    let artifactRefs;
    try {
      artifactRefs = await extractMavenArtifacts(content);
    } catch {
      console.warn(`java: failed to parse maven.artifact calls from ${file}`);
      continue;
    }

    for (const ref of artifactRefs) {
      if (!ref.group || !ref.artifact || !ref.version) continue;
      // Read-only refs (e.g. CONST.rpartition(".")[0]) cannot be rewritten — skip.
      if (ref.versionRef?.readOnly) continue;

      // standalone maven.artifact() calls have no parent maven.install() to inherit
      // repositories= from, so no repositories field is set here; registry lookups
      // fall back to the configured Maven Central URL.
      deps.push({
        ecosystem: "java",
        name: `${ref.group}:${ref.artifact}`,
        file,
        current: ref.version,
        position: { file, versionRef: ref.versionRef } satisfies JavaArtifactPosition,
      });
    }
  }

  return deps;
}

export async function buildFileEdits(
  candidates: UpdateCandidate[],
  style: UpdateStyle,
): Promise<FileEdit[]> {
  void style; // semver-only ecosystem; style (sha vs preserve) does not apply

  const byFile = groupByFile(candidates);

  const edits: FileEdit[] = [];

  for (const [file, fileCandidates] of byFile) {
    const versionRefCandidates: UpdateCandidate[] = [];
    const extraRewrites: FileEdit["rewrites"] = [];

    for (const candidate of fileCandidates) {
      const pos = candidate.dep.position as JavaArtifactPosition;

      if (pos.versionRef) {
        // Constant/interpolated version → offset-based rewrite of the constant literal,
        // built below via the shared bazel-shared.ts helper (same content-slice path as
        // rust/bazel) rather than the lossy no-content reconstruction fallback.
        versionRefCandidates.push(candidate);
      } else if (pos.artifactRaw) {
        // Inline literal coord → string-replace the old coord with the new one.
        const oldCoord = pos.artifactRaw;
        const parts = oldCoord.split(":");
        if (parts.length < 3) continue;
        // Legal Maven versions cannot contain ":", but candidate.latest originates from a
        // registry response that could theoretically be malformed. Writing a ":"-containing
        // value into parts[2] before join(":") would corrupt the coordinate (e.g.
        // "group:artifact:2.0.0:junk"). Fail closed rather than risk a silent corruption.
        if (candidate.latest.includes(":")) {
          core.warning(
            `[lisan] java: (${file}) skipping ${candidate.dep.name} — latest version ` +
            `${JSON.stringify(candidate.latest)} contains ":" and cannot be safely written ` +
            `into the group:artifact:version coordinate`,
          );
          continue;
        }
        parts[2] = candidate.latest;
        const newCoord = parts.join(":");

        extraRewrites.push({
          search: oldCoord,
          replace: newCoord,
        });
      }
    }

    const content = await readFileForConstantEdits(file);
    const rewrites = buildConstantEditsForFile(versionRefCandidates, file, content, extraRewrites);
    if (rewrites.length > 0) edits.push({ file, rewrites });
  }

  return edits;
}
