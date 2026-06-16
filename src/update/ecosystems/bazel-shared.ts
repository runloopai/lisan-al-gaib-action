import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as semver from "semver";
import type { VersionRef } from "../../ecosystems/types.js";
import type { FileEdit, OffsetRewrite, UpdateCandidate } from "../types.js";
import { partitionRewrites } from "../apply.js";

export interface BazelVersionPosition {
  file: string;
  versionRef: VersionRef;
  /** Cargo-style specifier prefix to preserve on rewrite, e.g. "=", "^", "~", ">=". */
  versionPrefix?: string;
}

/**
 * Given a new full version from the registry (e.g. "4.33.0") and a versionRef
 * that was derived from an interpolation template (e.g. `"4.%s" % CONST` where
 * templatePrefix = "4."), compute the new constant value to write ("33.0").
 *
 * For direct literals and bare-constant references (templatePrefix/Suffix = ""),
 * this is a no-op and candidate.latest is returned unchanged.
 *
 * Returns null if the candidate.latest is incompatible with the template
 * (e.g. doesn't start with templatePrefix), in which case the rewrite is skipped.
 */
export function computeNewConstantValue(latest: string, versionRef: VersionRef): string | null {
  const { templatePrefix, templateSuffix } = versionRef;
  let value = latest;
  if (templatePrefix) {
    if (!value.startsWith(templatePrefix)) return null;
    value = value.slice(templatePrefix.length);
  }
  if (templateSuffix) {
    if (!value.endsWith(templateSuffix)) return null;
    value = value.slice(0, value.length - templateSuffix.length);
  }
  // Round-trip guard: re-applying the template to the stripped value must
  // reproduce `latest` exactly. If not (e.g. overlapping prefix/suffix), the
  // stripped value is unsafe to write — skip with the caller's warning path.
  if (templatePrefix + value + templateSuffix !== latest) return null;
  if (!value.trim()) return null;  // degenerate template: stripped value is empty
  return value;
}

/**
 * Returns true when every version string in the array is coercible to semver.
 * Used by both reconcileConstantGroups (candidate selection) and
 * resolveConflictingReplaces (rewrite reconciliation) so the "drop on
 * non-comparable version" precondition is a single shared predicate.
 */
export function allVersionsComparable(versions: string[]): boolean {
  return versions.every((v) => semver.coerce(v) !== null);
}

/**
 * Given an array of items and a function to extract a version string from each,
 * returns the item whose version is the semver minimum (the highest version that
 * exists for all referencing deps — acceptability per dep is validated separately
 * via existence checks). Uses semver.coerce so 2-segment versions ("4.13",
 * "2.21") compare correctly alongside full semver.
 *
 * Returns null when the array is empty or all versions fail to coerce.
 */
export function pickSemverMin<T>(
  items: T[],
  versionOf: (item: T) => string,
): T | null {
  if (items.length === 0) return null;
  let minItem = items[0];
  // Prefer semver.valid() (strict) so that prerelease ordering is preserved:
  //   1.2.3-rc1 < 1.2.3 (strict), but semver.coerce() flattens both to 1.2.3.
  // Fall back to semver.coerce() only for 2-segment Maven/BCR versions like "4.13"
  // that strict semver rejects but coerce can handle.
  const resolveVersion = (v: string) =>
    semver.valid(v) ?? semver.coerce(v)?.version ?? null;
  let minResolved = resolveVersion(versionOf(minItem));
  for (let i = 1; i < items.length; i++) {
    const v = versionOf(items[i]);
    const sv = resolveVersion(v);
    if (!sv) continue; // non-semver: skip; keep current min
    if (!minResolved || semver.lt(sv, minResolved)) {
      minItem = items[i];
      minResolved = sv;
    }
  }
  return minResolved ? minItem : null;
}

/**
 * Build a single raw offset-based rewrite for a Starlark constant literal,
 * shared by rust/bazel (via buildBazelVersionEdits) and java (versionRef branch).
 *
 * Returns null with a warning when:
 *   - The template prefix/suffix is incompatible with versionPrefix (would produce
 *     corrupt output like `=4.=33.0`).
 *   - candidate.latest is incompatible with the template (computeNewConstantValue → null).
 *   - The old literal bytes cannot be computed for the stale-offset expected check.
 *
 * Callers should skip the candidate when null is returned.
 */
export function buildConstantRewrite(
  candidate: UpdateCandidate,
  versionRef: VersionRef,
  versionPrefix: string | undefined,
  file: string,
  content?: string,
): OffsetRewrite | null {
  // Read-only refs (e.g. CONST.rpartition(".")[0]) must never be rewritten — the constant
  // is driven by a non-lossy sibling reference.  Discover guards in the per-ecosystem
  // modules skip these, but this defense-in-depth check ensures no rewrite escapes if a
  // caller is added that doesn't apply the guard.
  if (versionRef.readOnly) {
    core.warning(
      `[lisan] apply: (${file}) skipping ${candidate.dep.name} — versionRef is read-only ` +
      `(lossy transform; constant is driven by a sibling reference)`,
    );
    return null;
  }

  // Combining a Cargo specifier prefix (e.g. "=") with a non-trivial template
  // (templatePrefix/Suffix) would produce garbage like "=4.=33.0".
  if (versionPrefix && (versionRef.templatePrefix || versionRef.templateSuffix)) {
    core.warning(
      `[lisan] apply: (${file}) skipping ${candidate.dep.name} — cannot combine ` +
      `Cargo specifier prefix "${versionPrefix}" with interpolation template ` +
      `"${versionRef.templatePrefix}%s${versionRef.templateSuffix}"`,
    );
    return null;
  }

  const newConstValue = computeNewConstantValue(candidate.latest, versionRef);
  if (newConstValue === null) {
    core.warning(
      `[lisan] apply: (${file}) skipping ${candidate.dep.name} — latest version ` +
      `${candidate.latest} is incompatible with template prefix ` +
      `"${versionRef.templatePrefix}" / suffix "${versionRef.templateSuffix}"`,
    );
    return null;
  }

  // Guard against a fuzzed/stale versionRef where nodeEnd < nodeStart — that produces a
  // negative `length` in the OffsetRewrite. apply.ts would catch the negative length and
  // throw, but that throw aborts ALL co-located edits in the same file rather than just
  // this candidate. Return null here so only the malformed candidate is skipped and valid
  // siblings in the same MODULE.bazel proceed normally.
  if (versionRef.nodeEnd < versionRef.nodeStart) {
    core.warning(
      `[lisan] apply: (${file}) skipping ${candidate.dep.name} — degenerate versionRef offsets ` +
      `(nodeEnd=${versionRef.nodeEnd} < nodeStart=${versionRef.nodeStart})`,
    );
    return null;
  }

  const q = versionRef.quote ?? '"';
  // The offset arithmetic (`nodeStart-1`, `nodeEnd+1`) assumes exactly one quote char
  // on each side of the literal.  Triple-quoted strings (""" or ''') have 3-char delimiters
  // and would produce an offset that lands inside the opening """ — corrupting the file.
  // The Starlark parser does not emit VersionRef for triple-quoted strings (resolveVersionExpr
  // returns null for them), so in practice q.length > 1 only if a fuzzed/malformed versionRef
  // reaches here.  Return null rather than silently produce a bad offset.
  if (q.length !== 1) {
    core.warning(
      `[lisan] apply: (${file}) skipping ${candidate.dep.name} — unsupported quote style ` +
      `(${JSON.stringify(q)}); offset arithmetic requires exactly one quote char on each side`,
    );
    return null;
  }

  // Compute the expected bytes for the stale-offset guard.
  // When `content` is provided (preferred path — like docker/k8s), slice the exact
  // bytes from the file content at discovery-time offsets. This avoids the lossy
  // round-trip of reconstructing expected from versionRef.value via computeNewConstantValue,
  // which can trigger the stale-offset guard spuriously when the file content bytes
  // differ from the reconstructed string in any way.
  // When `content` is absent (e.g. callers that do not have content available), fall
  // back to the old reconstruction logic for backward compatibility.
  let expected: string;
  if (content !== undefined) {
    // nodeStart is the first char INSIDE the quotes; nodeStart-1 is the opening quote.
    // nodeEnd is the exclusive end INSIDE the quotes; nodeEnd+1 is after the closing quote.
    expected = content.slice(versionRef.nodeStart - 1, versionRef.nodeEnd + 1);
  } else {
    const oldLiteral = computeNewConstantValue(versionRef.value, versionRef);
    if (oldLiteral === null) {
      core.warning(
        `[lisan] apply: (${file}) skipping ${candidate.dep.name} — ` +
        `cannot compute oldLiteral for stale-offset expected bytes: ` +
        `versionRef.value=${JSON.stringify(versionRef.value)} is incompatible with template ` +
        `"${versionRef.templatePrefix}%s${versionRef.templateSuffix}"`,
      );
      return null;
    }
    expected = `${q}${oldLiteral}${q}`;
  }

  return {
    offset: versionRef.nodeStart - 1,
    length: versionRef.nodeEnd - versionRef.nodeStart + 2,
    replace: `${q}${versionPrefix ?? ""}${newConstValue}${q}`,
    expected,
  };
}

export interface ReconcileResult {
  rewrites: FileEdit["rewrites"];
}

// extractSpecifier/stripInnerSpecifier: extract the Cargo specifier prefix from a quoted
// replace string like '"=1.2.3"'. Only used for conflict resolution between multiple
// deps sharing a constant — the specifier is part of the replace string by design
// (buildConstantRewrite includes the versionPrefix in the replace: field).
// This regex is intentionally Cargo-specific and lives here because resolveConflictingReplaces
// is only called for offset-based rewrites produced by Starlark/Rust/Java Bazel paths.
// Regex: consume any sequence of =^~<> and surrounding whitespace.
const SPECIFIER_RE_INNER = /^([=^~<>\s]+)/;
const extractSpecifier = (r: string): string =>
  (SPECIFIER_RE_INNER.exec(r.slice(1, -1))?.[1] ?? "").trim();
const stripInnerSpecifier = (r: string): string =>
  r.slice(1, -1).replace(SPECIFIER_RE_INNER, "");

/**
 * Resolve a set of conflicting replace-strings that all target the same constant literal
 * (same offset/length). Picks the semver-minimum replacement that is safe for all
 * referencing deps, handling Cargo-style specifier prefixes. Returns null to drop the
 * group entirely when the conflict cannot be safely resolved.
 */
export function resolveConflictingReplaces(
  candidates: string[],
  offset: number,
  file: string,
): string | null {
  // Multiple deps share this constant but want different versions. Pick the semver
  // minimum — the highest version that is safe for all referencing deps (each dep's
  // resolveLatest already accepted this version as age-compliant).
  const distinctSpecifiers = new Set(candidates.map(extractSpecifier));

  // If any dep uses an exact-pin specifier (=) alongside range specifiers, we
  // cannot safely pick one version for all consumers — an exact pin forces a
  // specific version that may be outside another dep's accepted range entirely
  // (e.g. =1.2.0 and ^2.0.0 share a constant; writing "=1.2.0" breaks ^2.x).
  if (distinctSpecifiers.size > 1 && [...distinctSpecifiers].some((s) => s === "=")) {
    core.warning(
      `[lisan] bazel-shared: (${file}) skipping shared constant at offset ${offset} — ` +
      `conflicting exact-pin (=) and range specifiers cannot be safely reconciled: ` +
      `${candidates.map((r) => JSON.stringify(r)).join(", ")}`,
    );
    return null;
  }

  // Also drop when ALL specifiers are exact-pin (=) but the inner versions differ —
  // writing the minimum "=X.Y.Z" to a dep that requires "=A.B.C" (different exact pin)
  // would break it, because "=" means exactly that version, not "at least".
  if ([...distinctSpecifiers].every((s) => s === "=")) {
    const innerVersions = new Set(candidates.map(stripInnerSpecifier));
    if (innerVersions.size > 1) {
      core.warning(
        `[lisan] bazel-shared: (${file}) skipping shared constant at offset ${offset} — ` +
        `all-exact-pin specifiers require different versions (${candidates.map((r) => JSON.stringify(r)).join(", ")}); cannot reconcile`,
      );
      return null;
    }
  }

  // Use pickSemverMin so 2-segment Maven/BCR versions like "4.13" or "2.21" compare
  // correctly (semver.valid rejects them, causing the whole group to be dropped).
  if (!allVersionsComparable(candidates.map(stripInnerSpecifier))) {
    core.warning(
      `[lisan] apply: (${file}) skipping conflicting rewrites at offset ${offset} ` +
      `(shared constant referenced by deps resolving to different versions: ` +
      `${candidates.map((r) => JSON.stringify(r)).join(", ")})`,
    );
    return null;
  }

  // pickSemverMin tracks the winning candidate by index (via identity), avoiding
  // indexOf mis-matches when two candidates share the same inner version string.
  const minReplace = pickSemverMin(candidates, stripInnerSpecifier);
  if (!minReplace) {
    core.warning(
      `[lisan] apply: (${file}) skipping conflicting rewrites at offset ${offset} — no comparable version found`,
    );
    return null;
  }
  core.warning(
    `[lisan] apply: (${file}) shared constant at offset ${offset} proposed by multiple deps ` +
    `(${candidates.map((r) => JSON.stringify(r)).join(", ")}); ` +
    `using minimum ${JSON.stringify(minReplace)} to satisfy all`,
  );
  // Warn when candidates carry more than one distinct Cargo specifier so the
  // user can verify the written specifier is correct for all referencing deps.
  if (distinctSpecifiers.size > 1) {
    const chosenSpecifier = extractSpecifier(minReplace);
    const chosenInner = stripInnerSpecifier(minReplace);
    core.warning(
      `[lisan] bazel-shared: shared constant at offset ${offset} has mixed Cargo specifiers ` +
      `(${[...distinctSpecifiers].map((s) => JSON.stringify(s || "(none)")).join(", ")}); ` +
      `writing specifier "${chosenSpecifier || "(none)"}" version "${chosenInner}" — ` +
      `verify Cargo resolution is still correct for all referencing deps`,
    );
  }
  return minReplace;
}

/**
 * Deduplicate offset-based rewrites targeting the same range (i.e. rewrites
 * to a shared constant value literal that multiple deps reference). Rules:
 *   - If all rewrites agree on the replacement text → emit one.
 *   - If they disagree and all proposed values are valid semver → pick the semver
 *     minimum (the highest version safe for all referencing deps) and warn.
 *   - If they disagree and the values are not all valid semver → drop all with a warning
 *     (non-semver constant values like partial template fragments can't be safely compared).
 *
 * Non-constant (unique-position) rewrites are passed through unchanged.
 */
/**
 * Reconcile a set of rewrites, deduplicating offset-based rewrites that target the
 * same constant literal node and resolving conflicts via semver-minimum selection.
 *
 * @param templateKeys — optional map from OffsetRewrite object → `"prefix:suffix"` template
 *   key (as produced by `buildBazelVersionEdits`/`buildJavaEdits`). When provided, any
 *   offset group whose entries carry different template keys is dropped with a warning
 *   instead of trying to reconcile replace-strings that are in incompatible "value spaces"
 *   (e.g. bare full version vs. inner value stripped of its template prefix).
 *
 *   When `templateKeys` is NOT provided (e.g. called from the cross-ecosystem merge in
 *   run.ts), the function is fail-closed: any offset group with more than one distinct
 *   `replace` value is dropped with a warning rather than attempting a semver-minimum pick
 *   across potentially incompatible template value-spaces. Only groups where all rewrites
 *   agree on an identical `replace` string (exact-pin case) are allowed through.
 */
/**
 * Precondition: every rewrite in `rewrites` must originate from `file`. The Rewrite
 * union (OffsetRewrite/StringRewrite, see types.ts) carries no per-item file
 * identity, so this cannot be checked from `rewrites` alone — offset:length grouping
 * below assumes the caller already scoped the batch to a single file (as
 * `buildConstantEditsForFile` does, which asserts this on its `candidates` input).
 * Passing rewrites from multiple files would silently merge unrelated offset
 * ranges that happen to collide.
 */
export function reconcileConstantRewrites(
  rewrites: FileEdit["rewrites"],
  file: string,
  templateKeys?: Map<object, string>,
): ReconcileResult {
  // Separate offset-based from string-based; only offset-based can conflict.
  // Shared triage warns and skips malformed rewrites rather than dropping silently.
  const { offsetRewrites, stringRewrites } = partitionRewrites(rewrites, file);

  // Group by (offset, length) — each unique range should produce one replacement.
  // In practice all rewrites to a shared constant reference the identical literal node,
  // so ranges are always exactly equal (never merely overlapping).
  const groups = new Map<string, {
    offset: number; length: number; expected: string;
    replaces: Set<string>;
    templateKey: string | undefined; // template key of the first entry
    templateMixed: boolean;          // true when entries carry different template keys
  }>();
  for (const rw of offsetRewrites) {
    const key = `${rw.offset}:${rw.length}`;
    const tk = templateKeys?.get(rw);
    const existing = groups.get(key);
    if (existing) {
      // Invariant: all rewrites in the same offset group must agree on `expected` —
      // they all reference the same literal bytes in the file. If they disagree, the
      // stale-offset guard in apply.ts would fire against the wrong bytes, letting a
      // corrupt write through. Warn and skip the conflicting rewrite rather than
      // silently discarding one `expected` in favour of another.
      if (rw.expected !== existing.expected) {
        core.warning(
          `[lisan] apply: (${file}) skipping offset-rewrite at ${rw.offset}:${rw.length} — ` +
          `conflicting "expected" bytes (${JSON.stringify(rw.expected.slice(0, 60))} vs ` +
          `${JSON.stringify(existing.expected.slice(0, 60))}); cannot safely determine which is current`,
        );
        continue;
      }
      // Detect mixed-template groups: if this entry's template key differs from the
      // first entry's, the replace-strings are in incompatible value spaces. Mark the
      // group for dropping rather than trying to pickSemverMin across incompatible spaces.
      if (templateKeys && tk !== existing.templateKey) {
        existing.templateMixed = true;
      }
      existing.replaces.add(rw.replace);
    } else {
      const group = {
        offset: rw.offset, length: rw.length, expected: rw.expected,
        replaces: new Set<string>(),
        templateKey: tk,
        templateMixed: false,
      };
      group.replaces.add(rw.replace);
      groups.set(key, group);
    }
  }

  const reconciledOffsets: { offset: number; length: number; expected: string; replace: string }[] = [];
  for (const { offset, length, expected, replaces, templateMixed } of groups.values()) {
    if (templateMixed) {
      // The same constant literal is referenced both as a bare version and via a template
      // — the replace-strings are in incompatible value spaces. Attempting to pick a
      // minimum would corrupt one consumer. Drop the group; reconcileConstantGroups in
      // run.ts already prevents this in the normal flow, so this guards future callers.
      core.warning(
        `[lisan] apply: (${file}) skipping constant at ${offset}:${length} — ` +
        `conflicting template/bare references that cannot be safely reconciled`,
      );
      continue;
    }
    if (replaces.size === 1) {
      reconciledOffsets.push({ offset, length, expected, replace: [...replaces][0] });
    } else if (!templateKeys) {
      // templateKeys unavailable — called from the cross-ecosystem merge in run.ts.
      // We cannot distinguish template-mixing from a legitimate semver conflict without
      // knowing the template key for each rewrite. Fail-closed: drop any conflicting
      // group to avoid template-space corruption rather than attempting a semver-minimum
      // pick across potentially incompatible value-spaces.
      core.warning(
        `[lisan] apply: (${file}) templateKeys unavailable — dropping conflicting constant ` +
        `group at ${offset}:${length} to avoid template-space corruption ` +
        `(${[...replaces].map((r) => JSON.stringify(r)).join(", ")})`,
      );
    } else {
      const replace = resolveConflictingReplaces([...replaces], offset, file);
      if (replace !== null) reconciledOffsets.push({ offset, length, expected, replace });
    }
  }

  const allRewrites = [...reconciledOffsets, ...stringRewrites];
  return { rewrites: allRewrites };
}

/**
 * Return the composite `"offset:length"` key for the OffsetRewrite that
 * `buildBazelVersionEdits` / `buildConstantRewrite` will emit for this candidate,
 * or undefined when the position has no versionRef (string-rewrite or missing data).
 *
 * Used by the attribution pass in `run.ts` so that the key computation lives in
 * exactly one place — next to the formula in `buildConstantRewrite` — rather than
 * being duplicated in `expectedOffsetKeyOf`. Matches `${rw.offset}:${rw.length}`
 * produced by `buildConstantRewrite`: offset = nodeStart-1, length = nodeEnd-nodeStart+2.
 */
export function rewriteKeyOf(candidate: UpdateCandidate): string | undefined {
  const pos = candidate.dep.position as BazelVersionPosition | null | undefined;
  const vr = pos?.versionRef;
  if (!vr || typeof vr.nodeStart !== "number" || typeof vr.nodeEnd !== "number") return undefined;
  if (vr.nodeEnd < vr.nodeStart) return undefined;
  return `${vr.nodeStart - 1}:${vr.nodeEnd - vr.nodeStart + 2}`;
}

/**
 * Read a file's content for use as the `content` argument to buildConstantRewrite,
 * so the exact expected bytes are sliced from the file rather than reconstructed
 * from versionRef fields (the drift-prone fallback path). Strips a leading BOM (if
 * present) so sliced offsets align with the parser's BOM-free view.
 *
 * Shared by every Starlark-constant-rewriting ecosystem (rust/bazel via
 * buildBazelVersionEdits, java via buildFileEdits) so the read/BOM-strip/warn
 * behavior cannot drift between them.
 */
export async function readFileForConstantEdits(file: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(file);
    const str = raw.toString("utf8");
    return str.startsWith("\uFEFF") ? str.slice(1) : str;
  } catch {
    // File unreadable at apply time — fall back to offset reconstruction.
    core.warning(`[lisan] bazel: could not read ${file} for expected-byte slicing; falling back to reconstruction`);
    return undefined;
  }
}

/**
 * Build the reconciled rewrite list for a single file's worth of versionRef candidates,
 * plus any pre-built string-based rewrites (e.g. java's inline-literal-coord replacements).
 *
 * Shared by buildBazelVersionEdits (rust/bazel) and java's buildFileEdits so both use the
 * same content-slice path through buildConstantRewrite and the same reconciliation pass,
 * instead of java reimplementing this loop against the lossier no-content fallback.
 */
export function buildConstantEditsForFile(
  candidates: UpdateCandidate[],
  file: string,
  content: string | undefined,
  extraRewrites: FileEdit["rewrites"] = [],
): FileEdit["rewrites"] {
  const rawRewrites: FileEdit["rewrites"] = [...extraRewrites];
  const templateKeys = new Map<object, string>();
  for (const candidate of candidates) {
    // Dev-time guard: reconcileConstantRewrites (called below) groups the rewrites built
    // here by "offset:length" alone, assuming every candidate targets the same `file`. A
    // future caller passing mixed-file candidates would silently merge unrelated offset
    // ranges. Skip (rather than throw) to stay consistent with this file's fail-safe,
    // warn-and-skip style for malformed input.
    if (candidate.dep.file !== file) {
      core.warning(
        `[lisan] bazel: (${file}) skipping ${candidate.dep.name} — candidate.dep.file ` +
        `${JSON.stringify(candidate.dep.file)} does not match the file being processed; ` +
        `buildConstantEditsForFile requires all candidates to target the same file`,
      );
      continue;
    }
    const pos = candidate.dep.position as BazelVersionPosition;
    const { versionRef, versionPrefix } = pos;
    const raw = buildConstantRewrite(candidate, versionRef, versionPrefix, file, content);
    if (raw === null) continue;
    rawRewrites.push(raw);
    templateKeys.set(raw, `${versionRef.templatePrefix}:${versionRef.templateSuffix}`);
  }

  const { rewrites } = reconcileConstantRewrites(rawRewrites, file, templateKeys);
  return rewrites;
}

export async function buildBazelVersionEdits(
  candidates: UpdateCandidate[],
): Promise<FileEdit[]> {
  // Group by file
  const byFile = new Map<string, UpdateCandidate[]>();
  for (const candidate of candidates) {
    const pos = candidate.dep.position as BazelVersionPosition;
    const arr = byFile.get(pos.file) ?? [];
    arr.push(candidate);
    byFile.set(pos.file, arr);
  }

  const edits: FileEdit[] = [];
  for (const [file, fileCandidates] of byFile) {
    const content = await readFileForConstantEdits(file);
    const rewrites = buildConstantEditsForFile(fileCandidates, file, content);
    if (rewrites.length > 0) edits.push({ file, rewrites });
  }
  return edits;
}
