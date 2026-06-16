import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileEdit, OffsetRewrite, Rewrite, StringRewrite } from "./types.js";

/**
 * Triage a heterogeneous list of rewrites into offset-based and string-based
 * buckets. Warns and skips any malformed Rewrite (one carrying both or neither
 * discriminating key) so it is never silently applied.
 */
export function partitionRewrites(
  rewrites: Rewrite[],
  file: string,
): { offsetRewrites: OffsetRewrite[]; stringRewrites: StringRewrite[] } {
  const offsetRewrites: OffsetRewrite[] = [];
  const stringRewrites: StringRewrite[] = [];
  for (const r of rewrites) {
    const hasOffset = "offset" in r;
    const hasSearch = "search" in r;
    if (hasOffset && hasSearch) {
      core.warning(`[lisan] apply: (${file}) malformed Rewrite has both "offset" and "search" keys — skipping`);
    } else if (hasOffset) {
      offsetRewrites.push(r as OffsetRewrite);
    } else if (hasSearch) {
      stringRewrites.push(r as StringRewrite);
    } else {
      core.warning(`[lisan] apply: (${file}) malformed Rewrite has neither "offset" nor "search" key — skipping`);
    }
  }
  return { offsetRewrites, stringRewrites };
}

/**
 * Read a file and apply all rewrites, returning the new file content string and
 * the set of search strings that were actually applied (not skipped).
 * Does NOT write to disk — use this for the validation phase of a two-phase write.
 *
 * Offset-based rewrites are applied in reverse order (highest offset first)
 * so earlier UTF-16 code-unit positions are not shifted by later edits.
 *
 * String-based rewrites use split/join to replace all occurrences across the file.
 * Only unambiguous (exactly one occurrence) rewrites are applied; ambiguous ones are
 * skipped with a warning and will NOT appear in `appliedSearches`.
 *
 * Throws if any rewrite has invalid offsets, overlaps, or stale expected bytes.
 */
export async function buildFileContent(edit: FileEdit): Promise<{ content: string; appliedSearches: Set<string> }> {
  // Read as a Buffer so a leading UTF-8 BOM (EF BB BF → \uFEFF) is not silently stripped.
  // fs.readFile(path, "utf8") drops the BOM on decode; Buffer.toString("utf8") preserves it.
  const rawBuf = await fs.readFile(edit.file);
  let content = rawBuf.toString("utf8");
  // Strip the BOM character for offset processing: parser offsets are relative to BOM-free content.
  const hasBom = content.startsWith("\uFEFF");
  if (hasBom) content = content.slice(1);

  const { offsetRewrites, stringRewrites } = partitionRewrites(edit.rewrites, edit.file);

  // Validate and apply offset-based rewrites in reverse order to preserve earlier positions.
  // Tie-break length descending (not ascending): at a shared offset, a positive-length
  // rewrite must sort before a zero-length insertion so the adjacency overlap check below
  // sees the positive-length range first and correctly treats a same-offset insertion as
  // a boundary case, not a skip.
  const sorted = [...offsetRewrites].sort((a, b) => b.offset - a.offset || b.length - a.length);
  // Guard against adversarial/garbage parsers emitting overlapping or out-of-bounds offsets.
  // NaN and non-integer values must be rejected explicitly: `NaN < 0` is false, so without
  // this check a fuzzed `offset: NaN` silently passes bounds and overlap validation.
  for (let i = 0; i < sorted.length; i++) {
    const rw = sorted[i];
    if (!Number.isInteger(rw.offset) || !Number.isInteger(rw.length)) {
      throw new Error(
        `[lisan] apply: offset rewrite has non-integer offset/length in ${edit.file}: ` +
        `offset=${rw.offset} length=${rw.length}`,
      );
    }
    if (rw.offset < 0 || rw.length < 0 || rw.offset + rw.length > content.length) {
      throw new Error(
        `[lisan] apply: offset rewrite out of bounds in ${edit.file}: ` +
        `offset=${rw.offset} length=${rw.length} fileLen=${content.length}`,
      );
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      // sorted descending, so prev.offset >= rw.offset; check that rw's end doesn't reach into prev's range.
      // Zero-length rewrites (length===0) are insertions at a point — they occupy no range
      // and cannot overlap anything. Skip the overlap check when either side has length===0:
      // a zero-length prev at the same offset as rw is not an overlap; a zero-length rw
      // at any position cannot extend into prev's range regardless of offset arithmetic.
      if (rw.length > 0 && prev.length > 0 && rw.offset + rw.length > prev.offset) {
        throw new Error(
          `[lisan] apply: overlapping offset rewrites in ${edit.file}: ` +
          `[${rw.offset},${rw.offset + rw.length}) overlaps [${prev.offset},${prev.offset + prev.length})`,
        );
      }
    }
  }
  // The adjacency check above only compares neighbors in offset order, so a zero-length
  // insertion sorted between two other rewrites (or sharing an offset with a non-adjacent
  // one) can still land strictly inside a positive-length rewrite's range without ever
  // being adjacent to it. Check every zero-length insertion against every positive-length
  // range directly — rewrite batches are small, so the O(n^2) scan is cheap.
  for (const rw of sorted) {
    if (rw.length !== 0) continue;
    for (const other of sorted) {
      if (other === rw || other.length === 0) continue;
      if (rw.offset > other.offset && rw.offset < other.offset + other.length) {
        throw new Error(
          `[lisan] apply: zero-length insertion at offset ${rw.offset} in ${edit.file} falls inside ` +
          `another rewrite's range [${other.offset},${other.offset + other.length})`,
        );
      }
    }
  }
  // Fail-closed stale-offset guard: verify the expected slice is still present
  // before any write. A mismatch means the file changed between discover and apply.
  for (const rewrite of sorted) {
    const actual = content.slice(rewrite.offset, rewrite.offset + rewrite.length);
    if (actual !== rewrite.expected) {
      throw new Error(
        `[lisan] apply: stale offset in ${edit.file} — ` +
        `expected ${JSON.stringify(rewrite.expected.slice(0, 120))} ` +
        `but found ${JSON.stringify(actual.slice(0, 120))}`,
      );
    }
  }
  for (const rewrite of sorted) {
    content =
      content.slice(0, rewrite.offset) +
      rewrite.replace +
      content.slice(rewrite.offset + rewrite.length);
  }

  // Apply string-based rewrites using split/join (replaceAll semantics).
  const appliedSearches = new Set<string>();
  for (const rewrite of stringRewrites) {
    // An identity rewrite (search === replace) is intentionally excluded from
    // appliedSearches: nothing actually changed, so a candidate whose only
    // rewrite is an identity no-op correctly surfaces as noEdits upstream
    // rather than being reported as applied.
    if (rewrite.search === rewrite.replace) continue;
    if (!content.includes(rewrite.search)) {
      core.warning(`[lisan] apply: search string not found in ${edit.file}: ${rewrite.search.slice(0, 60)}`);
      continue;
    }
    // Reject ambiguous rewrites: multiple occurrences mean we can't safely target
    // just the right one (e.g. "org.foo:bar:1.0" as a substring of "…:1.0.1").
    const occurrences = content.split(rewrite.search).length - 1;
    if (occurrences > 1) {
      core.warning(
        `[lisan] apply: skipping ambiguous string rewrite — ${occurrences} occurrences of ` +
        `${JSON.stringify(rewrite.search.slice(0, 60))} in ${edit.file}; ` +
        `manual update required to avoid corrupting the wrong occurrence`,
      );
      continue;
    }
    content = content.split(rewrite.search).join(rewrite.replace);
    appliedSearches.add(rewrite.search);
  }

  // Re-prepend the BOM so the written file preserves the original byte-order mark.
  if (hasBom) content = "\uFEFF" + content;
  return { content, appliedSearches };
}

/**
 * Apply a FileEdit to disk: computes the new content then writes atomically.
 *
 * For writing multiple files as a set, use the two-phase pattern: call
 * `buildFileContent` for each file first (validates all), then write all with
 * `writeFileContent` only if every validation succeeds. This is best-effort
 * set semantics, not a true multi-file transaction: each file's write is
 * individually atomic (rename-from-temp), but if a later file in the set
 * fails to write, earlier files already committed in this call are NOT rolled
 * back automatically — the caller is responsible for any cross-file rollback
 * policy (e.g. re-writing from a pre-change snapshot), which can itself fail
 * (e.g. the same read-only-filesystem condition that failed the write),
 * leaving a partially-updated tree. There is no journal or two-phase commit
 * across files.
 */
export async function applyFileEdit(edit: FileEdit): Promise<void> {
  const { content } = await buildFileContent(edit);
  await writeFileContent(edit.file, content);
}

/**
 * Stage `content` to a uniquely-named temp file in the same directory as `file`.
 * Returns the temp file path. The caller must either `commitTemp` or clean up
 * the temp file (via `fs.unlink`) — both are handled by `writeFileContent`.
 *
 * The temp name includes process PID, a timestamp, and a random token to guard
 * against same-file concurrent calls and PID-recycle stale-temp collisions.
 */
export async function stageTemp(file: string, content: string): Promise<string> {
  const absFile = path.resolve(file);
  const dir = path.dirname(absFile);
  const rnd = crypto.randomUUID().replace(/-/g, "");
  const tmp = path.join(dir, `.lisan-tmp-${process.pid}-${Date.now()}-${rnd}-${path.basename(absFile)}`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    return tmp;
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Commit a previously staged temp file to its final location via an atomic rename.
 * Cleans up the temp file on failure.
 */
export async function commitTemp(tmp: string, file: string): Promise<void> {
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Write content to a file atomically using a rename-from-temp approach.
 * If the process crashes mid-write the original file is left intact.
 * The temp file is created in the same directory to ensure rename stays
 * on the same filesystem (cross-device rename would require a copy).
 */
export async function writeFileContent(file: string, content: string): Promise<void> {
  const tmp = await stageTemp(file, content);
  await commitTemp(tmp, file);
}
