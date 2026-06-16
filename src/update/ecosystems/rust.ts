import { extractCrateSpecs } from "../../bazel.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";
import { type BazelVersionPosition, buildBazelVersionEdits, rewriteKeyOf } from "./bazel-shared.js";
export { rewriteKeyOf };
import { readModuleFilesSafe } from "./shared.js";

export async function discover(opts: {
  moduleBazel?: string;
}): Promise<DepRef[]> {
  const moduleBazelPath = opts.moduleBazel ?? "MODULE.bazel";
  const fileContents = await readModuleFilesSafe(moduleBazelPath, "rust");

  const deps: DepRef[] = [];

  for (const { file, content } of fileContents) {
    let specs;
    try {
      specs = await extractCrateSpecs(content);
    } catch {
      console.warn(`rust: failed to parse crate specs from ${file}`);
      continue;
    }

    for (const spec of specs) {
      if (spec.isGit) continue;
      if (!spec.versionRef) continue;
      // Read-only refs (e.g. CONST.rpartition(".")[0]) are resolved for age-gating by
      // the checker but must not be rewritten — the constant is driven by a sibling ref.
      if (spec.versionRef.readOnly) continue;

      // Split Cargo version specifier prefix (=, ^, ~, >=, <=, >, <) from the
      // bare semver so: (a) the registry lookup matches the published version, and
      // (b) the rewrite can re-prepend the original prefix.
      // Multi-requirement specs (comma-separated) can't be rewritten to a single
      // version, so skip them.
      const versionMatch = /^([=^~<>]*)(\d[\w.\-+]*)$/.exec(spec.version);
      if (!versionMatch) {
        console.info(`rust: skipping ${spec.package} — unsupported version spec: ${spec.version}`);
        continue;
      }
      const [, versionPrefix, bareVersion] = versionMatch;

      const position: BazelVersionPosition = {
        versionRef: spec.versionRef,
        file,
        versionPrefix,
      };

      deps.push({
        ecosystem: "rust",
        name: spec.package,
        file,
        current: bareVersion,
        position,
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
  return buildBazelVersionEdits(candidates);
}
