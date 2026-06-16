import { resolveFiles } from "../../diff.js";
import { parseActionRefsWithPositions, isCommitSha, DEFAULT_WORKFLOW_GLOBS } from "../../ecosystems/actions.js";
import { shaToTag } from "../latest.js";
import { groupByFile, readFilesSafe } from "./shared.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";

export interface ActionPosition {
  raw: string;
  matchOffset: number;      // UTF-16 code-unit offset of start of 'uses: <value>' match
  matchLength: number;      // UTF-16 code-unit length of 'uses: <value>' match (excludes trailing comment)
  trailingComment: string | null;  // e.g., '# v3.0.0' (trimmed, null if absent)
  trailingCommentLength: number;   // UTF-16 code-unit length of trailing comment segment (including leading whitespace); 0 if absent
  quoteChar: string | null; // '"' or "'" if the value was quoted in source, null if bare
  originalSpan: string;     // verbatim bytes of the full rewrite region (matchOffset … +matchLength+trailingCommentLength)
  file: string;
}

/**
 * Extract a version token from a trailing comment if the whole comment is a conventional
 * "# <version>" annotation (e.g. "# v4.1.1"). Returns null for multi-word comments or
 * tokens that don't look like version strings — those are preserved as author notes.
 *
 * Requires a leading `v` so that bare incidental numbers ("# 18", "# 20.04") used as
 * e.g. Node.js version hints or PR references are never mistaken for a pinned version,
 * which would silently corrupt those comments on rewrite. A stale "# v3" comment on a
 * SHA that actually points at v4 is accepted and used as the current-version baseline
 * without API verification (fast-path trade-off); see the comment below.
 */
const VERSION_TOKEN_RE = /^v\d+(\.\d+){0,2}([-+][a-zA-Z0-9.]+)?$/;
function commentVersionToken(comment: string): string | null {
  // Strip leading "# " and require a single whitespace-delimited token
  const stripped = comment.replace(/^#\s*/, "").trim();
  const spaceIdx = stripped.search(/\s/);
  if (spaceIdx !== -1) return null; // multi-word → not a version annotation
  return VERSION_TOKEN_RE.test(stripped) ? stripped : null;
}

// DEFAULT_WORKFLOW_GLOBS is imported from src/ecosystems/actions.ts (single source of truth).

export async function discover(opts: {
  workflowFiles?: string;
  token?: string;
}): Promise<DepRef[]> {
  let files: string[];

  if (opts.workflowFiles) {
    try {
      files = await resolveFiles(opts.workflowFiles);
    } catch {
      console.warn("actions: failed to resolve workflow files glob");
      return [];
    }
  } else {
    const fileSet = new Set<string>();
    for (const pattern of DEFAULT_WORKFLOW_GLOBS) {
      try {
        const resolved = await resolveFiles(pattern);
        for (const f of resolved) fileSet.add(f);
      } catch {
        // pattern didn't match anything
      }
    }
    files = [...fileSet];
  }

  const deps: DepRef[] = [];

  for (const { file, content } of await readFilesSafe(files, "actions")) {
    const refs = parseActionRefsWithPositions(content);

    for (const ref of refs) {
      const name = `${ref.owner}/${ref.repo}${ref.path ? "/" + ref.path : ""}`;

      // For SHA-pinned refs, recover the human-readable version so the registry
      // resolver and semver comparisons work correctly (a raw SHA coerces to a
      // garbage version like "8.0.0" and always looks like a downgrade).
      let current = ref.ref;
      if (isCommitSha(ref.ref)) {
        if (ref.trailingComment) {
          // Fast path: the conventional "# vX.Y.Z" comment carries the version.
          // Note: the comment is trusted without verifying it matches the SHA —
          // a stale "# v3" comment on a v4 SHA produces a wrong baseline and a
          // phantom downgrade/wrong breaking flag under --yes. This is an accepted
          // trade-off (saves one API call per action); the API slow-path below is
          // the correct path when no comment is present.
          // TODO(--yes hardening): discover() has no visibility into whether this run
          // is unattended (opts carries no `yes`/`allowAutoApply` flag, and threading
          // one through would require changes in run.ts's dispatch). If that plumbing
          // is ever added, consider verifying `fromComment` against `ref.ref` via
          // shaToTag (as used in the slow path below) before trusting it under --yes,
          // so a stale comment can't drive an unattended major-version auto-bump.
          const fromComment = commentVersionToken(ref.trailingComment);
          if (fromComment) {
            current = fromComment;
          } else {
            // Comment exists but isn't a version — fall through to API lookup.
            current = await shaToTag(name, ref.ref, opts.token ?? "") ?? ref.ref;
            if (current === ref.ref) {
              console.info(`actions: skipping ${name}@${ref.ref} — could not determine version from comment or tags`);
              continue;
            }
          }
        } else {
          // No comment at all — query the GitHub tags API to find the unique tag.
          const tag = await shaToTag(name, ref.ref, opts.token ?? "");
          if (!tag) {
            console.info(`actions: skipping ${name}@${ref.ref} — no unique version tag found for this SHA`);
            continue;
          }
          current = tag;
        }
      }

      const position: ActionPosition = {
        raw: ref.raw,
        matchOffset: ref.matchOffset,
        matchLength: ref.matchLength,
        trailingComment: ref.trailingComment,
        trailingCommentLength: ref.trailingCommentLength,
        quoteChar: ref.quoteChar,
        originalSpan: content.slice(ref.matchOffset, ref.matchOffset + ref.matchLength + ref.trailingCommentLength),
        file,
      };
      deps.push({
        ecosystem: "actions",
        name,
        file,
        current,
        position,
      });
    }
  }

  return deps;
}

/**
 * Return the composite `"offset:length"` key for the OffsetRewrite that
 * `buildFileEdits` will emit for this candidate, or undefined when the
 * position data is missing or malformed.
 *
 * Matches `${rw.offset}:${rw.length}` produced by `buildFileEdits`:
 *   offset = matchOffset, length = matchLength + trailingCommentLength
 */
export function rewriteKeyOf(candidate: UpdateCandidate): string | undefined {
  const pos = candidate.dep.position as ActionPosition | null | undefined;
  if (!pos || typeof pos.matchOffset !== "number") return undefined;
  return `${pos.matchOffset}:${pos.matchLength + pos.trailingCommentLength}`;
}

export function buildFileEdits(
  candidates: UpdateCandidate[],
  style: UpdateStyle,
): FileEdit[] {
  const byFile = groupByFile(candidates);

  const edits: FileEdit[] = [];

  for (const [file, fileCandidates] of byFile) {
    const rewrites: FileEdit["rewrites"] = [];

    for (const candidate of fileCandidates) {
      const pos = candidate.dep.position as ActionPosition;
      const name = candidate.dep.name;

      // The full extent to replace: from match start through end of trailing comment (if any)
      const offset = pos.matchOffset;
      const length = pos.matchLength + pos.trailingCommentLength;

      const q = pos.quoteChar ?? "";
      let replace: string;
      if (style === "sha" && candidate.pinnedTo) {
        // Pin to SHA, preserving the original quote char. For the trailing comment:
        // if the existing comment was NOT a version token (a meaningful note), keep it
        // verbatim; otherwise write/update the conventional "# <version>" comment.
        const commentWasVersion = pos.trailingComment
          ? commentVersionToken(pos.trailingComment) !== null
          : false;
        const trailingComment =
          pos.trailingComment && !commentWasVersion
            ? `  ${pos.trailingComment}` // preserve non-version comment
            : `  # ${candidate.latest}`; // replace version comment or add new
        replace = `uses: ${q}${name}@${candidate.pinnedTo}${q}${trailingComment}`;
      } else {
        // Preserve style (or sha but no pinnedTo) — just update the tag,
        // re-wrapping in the original quote character if the source used one.
        //
        // Guard: if the source ref is currently pinned to a commit SHA, never fall
        // through to a tag rewrite here — that would silently downgrade an immutable
        // pin to a mutable tag (a supply-chain regression), the exact risk this tool
        // exists to prevent. Skip with a warning instead; `--style sha` is the path
        // that re-pins to the new commit SHA.
        const atIdx = pos.raw.lastIndexOf("@");
        const originalRef = atIdx >= 0 ? pos.raw.slice(atIdx + 1) : "";
        if (isCommitSha(originalRef)) {
          console.warn(
            `actions: skipping ${name} — currently pinned to commit ${originalRef}; ` +
            "refusing to rewrite a SHA pin to a mutable tag under --style preserve. " +
            "Use --style sha to update the pin instead.",
          );
          continue;
        }

        // If the trailing comment carried the old version tag, update it to the
        // new version so it doesn't become stale after the rewrite.
        let commentSuffix = "";
        if (pos.trailingComment) {
          const commentWasVersion = commentVersionToken(pos.trailingComment) !== null;
          commentSuffix = commentWasVersion
            ? `  # ${candidate.latest}`
            : `  ${pos.trailingComment}`;
        }
        replace = `uses: ${q}${name}@${candidate.latest}${q}${commentSuffix}`;
      }

      rewrites.push({ offset, length, replace, expected: pos.originalSpan });
    }

    if (rewrites.length > 0) {
      edits.push({ file, rewrites });
    }
  }

  return edits;
}
