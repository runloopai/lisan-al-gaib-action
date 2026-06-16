import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { buildFileContent, stageTemp, commitTemp, writeFileContent } from "./apply.js";
import { reconcileConstantRewrites } from "./ecosystems/bazel-shared.js";
import { ECOSYSTEM_DISPATCH, expectedOffsetKeyOf, expectedSearchStringOf, realpathOr } from "./dispatch.js";
import type { FileEdit, UpdateCandidate, UpdateStyle } from "./types.js";

// ── buildAndApplyEdits phases ─────────────────────────────────────────────────
//
// The write pipeline is decomposed into five independently-testable helpers.
// buildAndApplyEdits (the orchestrator, ~30 lines) calls them in order.

/**
 * Phase 1: build FileEdits per ecosystem.
 * Multiple ecosystems (rust/java/bazel) may edit the same MODULE.bazel — they are
 * merged later; this phase just collects all edits and records build failures.
 * A co-targeting warning is emitted when a build-failed ecosystem shares source
 * files with a successful one (the file will still be written by the other ecosystem).
 */
async function buildEditsByEcosystem(
  selected: UpdateCandidate[],
  style: UpdateStyle,
): Promise<{ allEdits: FileEdit[]; failed: UpdateCandidate[]; buildFailedSet: Set<UpdateCandidate> }> {
  const allEdits: FileEdit[] = [];
  const failed: UpdateCandidate[] = [];

  const byEcosystem = new Map<string, UpdateCandidate[]>();
  for (const candidate of selected) {
    const eco = candidate.dep.ecosystem;
    const arr = byEcosystem.get(eco) ?? [];
    arr.push(candidate);
    byEcosystem.set(eco, arr);
  }

  for (const [eco, ecoCandidates] of byEcosystem) {
    try {
      const dispatch = ECOSYSTEM_DISPATCH[eco];
      if (!dispatch) {
        core.warning(`[lisan] no buildFileEdits for ecosystem: ${eco}`);
        continue;
      }
      allEdits.push(...await dispatch.buildFileEdits(ecoCandidates, style));
    } catch (err) {
      core.warning(
        `[lisan] failed to build edits for ${eco}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed.push(...ecoCandidates);
    }
  }

  if (failed.length > 0) {
    const failedFiles = new Set(failed.map((c) => c.dep.file));
    const successFiles = new Set(allEdits.map((e) => e.file));
    for (const f of failedFiles) {
      if (successFiles.has(f)) {
        core.warning(
          `[lisan] (${f}) will be written by a co-targeting ecosystem despite ` +
          `a build failure in another — review the resulting diff carefully`,
        );
      }
    }
  }

  return { allEdits, failed, buildFailedSet: new Set<UpdateCandidate>(failed) };
}

/**
 * Phase 2: group edits by realpath so multiple ecosystems targeting the same
 * physical file have their rewrites merged into a single write operation.
 * Also builds fileToRealpath for later candidate classification without extra syscalls.
 */
async function mergeEditsByRealpath(
  allEdits: FileEdit[],
): Promise<{
  editsByRealpath: Map<string, { file: string; rewrites: FileEdit["rewrites"] }>;
  fileToRealpath: Map<string, string>;
}> {
  const editsByRealpath = new Map<string, { file: string; rewrites: FileEdit["rewrites"] }>();
  const fileToRealpath = new Map<string, string>();
  for (const edit of allEdits) {
    const realpath = await realpathOr(edit.file);
    fileToRealpath.set(edit.file, realpath);
    const existing = editsByRealpath.get(realpath);
    if (existing) {
      existing.rewrites = [...existing.rewrites, ...edit.rewrites];
    } else {
      editsByRealpath.set(realpath, { file: edit.file, rewrites: [...edit.rewrites] });
    }
  }
  return { editsByRealpath, fileToRealpath };
}

/**
 * Phase 3: validate and build content strings in memory.
 * Calls reconcileConstantRewrites (dedup/conflict-resolution for cross-ecosystem
 * rewrites on the same constant), then buildFileContent (bounds/overlap/stale-offset).
 * If ANY file fails, it is recorded in failedRealpaths; computedContents contains
 * only the files that passed. No disk writes happen here — failures abort in Phase 5.
 */
async function computeAndReconcileEdits(
  editsByRealpath: Map<string, { file: string; rewrites: FileEdit["rewrites"] }>,
): Promise<{
  computedContents: Map<string, { file: string; content: string; rewrites: FileEdit["rewrites"]; appliedSearches: Set<string> }>;
  failedRealpaths: Set<string>;
}> {
  const computedContents = new Map<string, { file: string; content: string; rewrites: FileEdit["rewrites"]; appliedSearches: Set<string> }>();
  const failedRealpaths = new Set<string>();
  for (const [realpath, { file, rewrites }] of editsByRealpath) {
    try {
      // reconcileConstantRewrites deduplicates offset-based rewrites from different
      // ecosystems targeting the same constant literal, picking the semver-minimum on
      // conflict. buildBazelVersionEdits already calls it for single-ecosystem dedup;
      // this second call (idempotent for size-1 groups) handles cross-ecosystem cases
      // where rust + java + bazel each emit a rewrite for the same MODULE.bazel constant.
      const { rewrites: merged } = reconcileConstantRewrites(rewrites, file);
      const { content, appliedSearches } = await buildFileContent({ file, rewrites: merged });
      computedContents.set(realpath, { file, content, rewrites: merged, appliedSearches });
    } catch (err) {
      core.warning(
        `[lisan] failed to build edits for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failedRealpaths.add(realpath);
    }
  }
  return { computedContents, failedRealpaths };
}

/**
 * Phase 4: attribute surviving rewrites back to candidates (post-reconcile).
 * Must run AFTER Phase 3 so offsets dropped by reconcileConstantRewrites correctly
 * demote their candidates to noEdits rather than being misclassified as applied via
 * a sibling dep's write on the same file.
 *
 * Tracks by "offset:length" composite keys (OffsetRewrite) or search strings
 * (StringRewrite — java inline literals). A bare offset key would falsely attribute
 * a candidate whose rewrite was dropped if an unrelated rewrite at the same start
 * offset (but different length) survived in the same file.
 */
function attributeRewrites(
  selected: UpdateCandidate[],
  computedContents: Map<string, { file: string; content: string; rewrites: FileEdit["rewrites"]; appliedSearches: Set<string> }>,
  fileToRealpath: Map<string, string>,
  buildFailedSet: Set<UpdateCandidate>,
): Set<UpdateCandidate> {
  const survivingOffsetKeysByRealpath = new Map<string, Set<string>>();
  const survivingSearchesByRealpath = new Map<string, Set<string>>();
  for (const [realpath, { rewrites: survived, appliedSearches }] of computedContents) {
    const offsetKeys = new Set<string>();
    for (const r of survived) {
      if ("offset" in r) offsetKeys.add(`${r.offset}:${r.length}`);
    }
    survivingOffsetKeysByRealpath.set(realpath, offsetKeys);
    // Use appliedSearches from buildFileContent — reflects searches that were actually
    // applied (not skipped due to ambiguity). Building from `survived` (merged rewrites
    // before apply) would incorrectly mark ambiguous-skipped candidates as "applied".
    survivingSearchesByRealpath.set(realpath, appliedSearches);
  }

  const candidatesWithAnyEdit = new Set<UpdateCandidate>();
  for (const c of selected) {
    if (buildFailedSet.has(c)) continue;
    const realpath = fileToRealpath.get(c.dep.file) ?? c.dep.file;

    const offsetKey = expectedOffsetKeyOf(c);
    if (offsetKey !== undefined) {
      if (survivingOffsetKeysByRealpath.get(realpath)?.has(offsetKey)) candidatesWithAnyEdit.add(c);
      continue;
    }
    const search = expectedSearchStringOf(c);
    if (search !== undefined) {
      if (survivingSearchesByRealpath.get(realpath)?.has(search)) candidatesWithAnyEdit.add(c);
      continue;
    }
    // Unknown position type (future ecosystems): add conservatively so the file-written
    // check in the orchestrator still applies rather than silently routing to noEdits.
    candidatesWithAnyEdit.add(c);
  }
  return candidatesWithAnyEdit;
}

/**
 * Phase 5: write validated content strings to disk atomically.
 *   5a — stage each file to a temp in the same directory (same filesystem → fast rename).
 *        If ANY staging fails (ENOSPC/EACCES/RO mount), clean up all staged temps and abort.
 *   5b — commit each staged temp via rename. Near-instant on same filesystem; if a
 *        rename fails mid-commit, surface a "partially applied" error with `git diff` hint.
 *
 * If `initialFailedRealpaths` is non-empty, skips all writes (validation already failed).
 */
async function stageAndCommitEdits(
  computedContents: Map<string, { file: string; content: string; rewrites: FileEdit["rewrites"]; appliedSearches: Set<string> }>,
  initialFailedRealpaths: Set<string>,
): Promise<{ writtenRealpaths: Set<string>; failedRealpaths: Set<string> }> {
  const failedRealpaths = new Set<string>(initialFailedRealpaths);
  const writtenRealpaths = new Set<string>();

  if (failedRealpaths.size > 0) {
    core.warning(
      `[lisan] aborting all writes — ${failedRealpaths.size} file(s) failed validation`,
    );
    for (const realpath of computedContents.keys()) failedRealpaths.add(realpath);
    return { writtenRealpaths, failedRealpaths };
  }

  // 5a: stage — also snapshot original file bytes for rollback if 5b fails mid-commit.
  const staged = new Map<string, { tmp: string; file: string }>();
  const snapshots = new Map<string, { file: string; originalContent: string }>();
  let stagingFailed = false;
  for (const [realpath, { file, content }] of computedContents) {
    try {
      // B2: Distinguish ENOENT (new file → snapshot as "") from other errors like EACCES/EISDIR.
      // Previously `catch(() => "")` treated any read error as "new file". If the file
      // existed but was unreadable (EACCES), rollback would write "" → truncate the file.
      // Now: only ENOENT is treated as "new file"; other errors skip snapshotting entirely
      // so a failing rollback cannot corrupt the file.
      // Read as Buffer so a leading UTF-8 BOM is not silently stripped on decode.
      // Buffer.toString("utf8") preserves the BOM char; fs.readFile(path,"utf8") drops it.
      const originalContent = await fs.readFile(file).then(
        (buf) => buf.toString("utf8"),
        (err: unknown) => {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return "";
          // Not a new file — skip snapshotting to avoid a truncating rollback on EACCES/EISDIR.
          return null;
        },
      );
      const tmp = await stageTemp(file, content);
      staged.set(realpath, { tmp, file });
      if (originalContent !== null) {
        snapshots.set(realpath, { file, originalContent });
      }
    } catch (err) {
      core.warning(`[lisan] failed to stage ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failedRealpaths.add(realpath);
      stagingFailed = true;
    }
  }
  if (stagingFailed) {
    core.warning(
      `[lisan] aborting all writes — staging failed for ${failedRealpaths.size} file(s); cleaning up staged temps`,
    );
    for (const { tmp } of staged.values()) await fs.unlink(tmp).catch(() => undefined);
    for (const realpath of computedContents.keys()) {
      if (!failedRealpaths.has(realpath)) failedRealpaths.add(realpath);
    }
    return { writtenRealpaths, failedRealpaths };
  }

  // 5b: commit
  let commitFailed = false;
  for (const [realpath, { tmp, file }] of staged) {
    try {
      await commitTemp(tmp, file);
      writtenRealpaths.add(realpath);
    } catch (err) {
      core.warning(`[lisan] failed to commit ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failedRealpaths.add(realpath);
      commitFailed = true;
      // Best-effort rollback of already-committed files to avoid a partially-applied changeset.
      for (const committedRealpath of writtenRealpaths) {
        const snap = snapshots.get(committedRealpath);
        if (!snap) continue;
        try {
          await writeFileContent(snap.file, snap.originalContent);
          core.warning(`[lisan] rolled back ${snap.file} to original content`);
        } catch {
          core.warning(
            `[lisan] rollback failed for ${snap.file} — tree may be partially mutated; ` +
            `run "git diff" and "git checkout ${snap.file}" to restore`,
          );
        }
      }
      // B1: Unlink staged temps that were not successfully committed.
      // This covers two cases:
      //   (a) files whose commitTemp threw (their tmp was not renamed, still on disk)
      //   (b) files whose commitTemp was never called (loop exited via `break` before
      //       reaching them — their tmp is also still on disk)
      // Without this cleanup, both cases leave orphaned `.lisan-tmp-*` files.
      // The correct guard is: any staged temp that is NOT in writtenRealpaths
      // (i.e. commitTemp never successfully completed for it).
      for (const [remainingRp, { tmp }] of staged) {
        if (!writtenRealpaths.has(remainingRp)) {
          await fs.unlink(tmp).catch(() => undefined);
        }
      }
      break; // stop committing further files after failure
    }
  }
  if (commitFailed) {
    core.warning(
      `[lisan] partially applied — ${writtenRealpaths.size} of ${staged.size} file(s) written; ` +
      `run "git diff" to inspect the partial state`,
    );
  }
  return { writtenRealpaths, failedRealpaths };
}

/**
 * Build per-ecosystem FileEdits for the selected candidates, merge edits that
 * target the same physical file (resolving symlinks), reconcile shared-constant
 * conflicts, and write each merged edit to disk.
 *
 * Calls the five phase helpers above in sequence. Returns the candidates whose
 * file was successfully written (`actuallyApplied`) and those that failed (`failed`).
 */
export async function buildAndApplyEdits(
  selected: UpdateCandidate[],
  style: UpdateStyle,
  dryRun: boolean,
): Promise<{ actuallyApplied: UpdateCandidate[]; failed: UpdateCandidate[]; noEdits: UpdateCandidate[] }> {
  const actuallyApplied: UpdateCandidate[] = [];
  const failed: UpdateCandidate[] = [];
  const noEdits: UpdateCandidate[] = [];

  if (selected.length === 0) return { actuallyApplied, failed, noEdits };

  const { allEdits, failed: buildFailed, buildFailedSet } = await buildEditsByEcosystem(selected, style);
  failed.push(...buildFailed);

  const { editsByRealpath, fileToRealpath } = await mergeEditsByRealpath(allEdits);
  const { computedContents, failedRealpaths: validationFailed } = await computeAndReconcileEdits(editsByRealpath);
  const candidatesWithAnyEdit = attributeRewrites(selected, computedContents, fileToRealpath, buildFailedSet);

  // In dry-run mode, skip the file-write phase but still classify candidates so that
  // noEdits is accurately populated. This ensures the dry-run preview omits candidates
  // that an actual run would silently skip (multi-line FROM, template-incompatible
  // constant, reconcile-dropped shared constant, unresolvable digest), rather than
  // falsely listing them as "would be applied".
  if (dryRun) {
    for (const c of selected) {
      if (buildFailedSet.has(c)) continue;
      if (!candidatesWithAnyEdit.has(c)) noEdits.push(c);
    }
    return { actuallyApplied, failed, noEdits };
  }

  const { writtenRealpaths, failedRealpaths } = await stageAndCommitEdits(computedContents, validationFailed);

  // Classify each candidate that wasn't already recorded as a build failure.
  for (const c of selected) {
    if (buildFailedSet.has(c)) continue;

    if (!candidatesWithAnyEdit.has(c)) {
      // buildFileEdits produced no rewrite — known benign reasons: unresolvable digest,
      // template mismatch, reconcile-dropped shared constant, multi-line FROM. The ecosystem
      // module already emitted a warning for each. Distinct from `failed` (no write attempted)
      // and from `skipped` (these were positively selected). Under --yes, this is not an error
      // — the ecosystem module's warning is sufficient for operator awareness.
      noEdits.push(c);
      continue;
    }

    const realpath = fileToRealpath.get(c.dep.file)
      ?? await realpathOr(c.dep.file);
    if (writtenRealpaths.has(realpath)) {
      actuallyApplied.push(c);
    } else if (failedRealpaths.has(realpath)) {
      failed.push(c);
    } else {
      // candidatesWithAnyEdit but not in writtenRealpaths or failedRealpaths —
      // should not happen by construction. Counts as a failure: the user selected this
      // candidate (or --yes did) and expected a write; treat as unexpected to surface exit 1.
      core.warning(
        `[lisan] unexpected: ${c.dep.name} (${c.dep.file}) produced an edit but was not ` +
        `written or recorded as failed — check for a file-system or symlink issue`,
      );
      failed.push(c);
    }
  }

  return { actuallyApplied, failed, noEdits };
}
