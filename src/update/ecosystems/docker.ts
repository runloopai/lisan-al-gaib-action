import * as core from "@actions/core";
import { parseDockerfileImagesWithPositions } from "../../ecosystems/docker.js";
import {
  makeName,
  makeVersion,
  buildReplacedImageRef,
  parseImageRef,
  confirmCopyMountFromExists,
} from "../../ecosystems/image.js";
import { lineStartOffsets, groupByFile, readFilesSafe, discoverViaGlobs, DEFAULT_GLOB_EXCLUSIONS } from "./shared.js";
import type { DepRef, FileEdit, UpdateCandidate, UpdateStyle } from "../types.js";
import type { ParsedImageRef } from "../../ecosystems/types.js";

export interface DockerPosition {
  raw: string;
  absoluteOffset: number;         // absolute UTF-16 code-unit offset of image ref in file content
  refLength: number;              // UTF-16 code-unit length of image ref string
  trailingConsumeLength: number;  // for FROM: code-units after ref to consume (AS clause + any trailing comment), always spans absoluteInstrEnd so expected covers the full region
  isMultiLine: boolean;            // for FROM: true when the instruction spans >1 line (backslash continuation)
  existingTrailingComment: string; // for FROM: any trailing "# …" comment found in the consumed span (preserved verbatim)
  restOfLine: string;             // for FROM: reconstructed " AS <stage>" (or "") for the replacement
  instructionOffset: number;      // absolute UTF-16 code-unit offset of the instruction's first line
  indent: string;                 // leading whitespace of the instruction's first line
  hasPrevLineComment: boolean;    // true if "# was <raw>" already exists above this instruction
  source: "from" | "copy-from" | "mount-from";
  registry: string;
  repository: string;
  tag: string | null;
  digest: string | null;
  file: string;
  expected: string;               // verbatim bytes that will be overwritten by this rewrite (for conflict detection)
}

// Single multiline pattern string passed to a single glob.create() call so that
// the !-prefixed exclusions apply globally across all positive patterns.
// DEFAULT_GLOB_EXCLUSIONS is imported from shared.ts (single source of truth).
const DEFAULT_DOCKERFILE_GLOB_PATTERN = [
  "**/Dockerfile",
  "**/Containerfile",
  "**/dockerfile",
  "**/containerfile",
  ...DEFAULT_GLOB_EXCLUSIONS,
].join("\n");

/**
 * For a FROM instruction, compute how many code-units after the image ref to
 * consume in the rewrite (spanning any AS clause plus a trailing "#" comment,
 * up to the instruction's parsed end), and extract any existing trailing
 * comment that must be re-appended verbatim (as opposed to a previously-injected
 * "# was <token>" tool annotation, which is consumed entirely and replaced).
 */
function reconcileFromTrailingComment(
  content: string,
  lineStarts: number[],
  instrEndLine: number,
  instrEndChar: number,
  absoluteOffset: number,
  refLength: number,
  itemRef: ParsedImageRef,
): { trailingConsumeLength: number; existingTrailingComment: string } {
  let existingTrailingComment = "";

  // A1: When instrEndLine === lines.length (last instruction has no trailing newline),
  // lineStarts[instrEndLine] is undefined. Fall back to content.length (end of file)
  // rather than to the last LINE START — the last line start is less than the file
  // end, which makes absoluteInstrEnd < absoluteOffset + refLength, collapsing
  // trailingConsumeLength to 0 and leaving any AS <stage> clause un-consumed.
  const instrEndLineStart = lineStarts[instrEndLine] ?? content.length;
  const absoluteInstrEnd = instrEndLineStart + instrEndChar;
  const trailingConsumeLength = Math.max(0, absoluteInstrEnd - (absoluteOffset + refLength));

  // Detect an existing trailing "#" comment in the consumed span. Author comments
  // are preserved (re-appended after the new "# was" note). A previously-injected
  // "# was <X>" annotation is consumed entirely and not re-appended — the new
  // "# was <current>" replaces it, preventing comment accumulation on re-runs.
  //
  // IMPORTANT: trailingConsumeLength must always span the FULL instruction end
  // (including any trailing comment), so that `expected` covers the whole region
  // and the stale-offset guard in apply.ts catches file mutations. The
  // existingTrailingComment is re-appended in buildFileEdits, not left in place.
  if (trailingConsumeLength > 0) {
    const consumedSpan = content.slice(absoluteOffset + refLength, absoluteOffset + refLength + trailingConsumeLength);
    // A3: Find the "#" comment start by locating the end of the actual "AS <stage>"
    // clause in the consumed span rather than using restOfLine.length as the search
    // offset. restOfLine is reconstructed from the AST and uses a single space before
    // AS, but the source may have double-spaces (e.g. "FROM nginx  AS  build"), making
    // the reconstructed length shorter than the actual consumed AS span — a "#" before
    // the real end would then be mis-located as the comment start.
    // Using the actual regex match against consumedSpan avoids this.
    const asMatch = /\bAS\s+\S+/i.exec(consumedSpan);
    const hashSearchStart = asMatch ? asMatch.index + asMatch[0].length : 0;
    const hashIdx = consumedSpan.indexOf("#", hashSearchStart);
    if (hashIdx !== -1) {
      const comment = consumedSpan.slice(hashIdx);
      // Detect whether the comment is a previously-injected "# was <token>"
      // annotation (possibly followed by an author comment) or a pure author
      // comment.
      //
      // Strategy: match "/^#\s*was\s+(\S+)\s*/s" against the trimmed comment.
      // If the prefix matches, the captured token is the annotation ref; any
      // text remaining after it is the author comment. This approach correctly
      // handles cases like:
      //   "# was nginx:1.24  # prod"   → annotation token "nginx:1.24", author "# prod"
      //   "# was repo#weird:1"          → annotation token "repo#weird:1", no author
      //   "# keep this around"          → no annotation match → entire comment is author
      // Unlike the previous indexOf("#",1) approach, it never splits mid-token on
      // an embedded "#" inside the ref itself (M-container-1 fix).
      const trimmed = comment.trimStart();
      const annotationMatch = /^#\s*was\s+(\S+)(\s*)(.*)/s.exec(trimmed);
      // Only treat as a tool-injected annotation when the captured token is a parseable
      // image reference for the SAME repository AND registry as item.raw. A tool
      // annotation always names the exact prior ref of the same image, so its registry
      // can never differ from the current one — matching repository alone would let a
      // same-named repository on a *different* registry (e.g. a private mirror also
      // called "alpine") be misclassified as our own annotation. The copy-from path
      // already uses an exact item.raw match; this brings FROM as close to that
      // conservative standard as its "prior ref, not current ref" shape allows.
      const annotationToken = annotationMatch?.[1] ?? "";
      const annotationRef = annotationToken ? parseImageRef(annotationToken) : null;
      const isAnnotation = annotationMatch !== null &&
        annotationRef !== null &&
        annotationRef.repository === itemRef.repository &&
        annotationRef.registry === itemRef.registry;
      if (isAnnotation && annotationMatch) {
        // Previously-injected annotation: consume it entirely and replace with the
        // new "# was <current>" note. Extract any trailing author comment for re-append.
        const remainder = annotationMatch[3].trimStart();
        if (remainder.length > 0) {
          // Author comment follows the annotation token — preserve it for re-append.
          // trailingConsumeLength stays unchanged — full span consumed atomically.
          existingTrailingComment = remainder.startsWith("#") ? remainder : `# ${remainder}`;
        } else {
          existingTrailingComment = "";
        }
      } else {
        // Genuine author comment: capture for re-append, consume the full span
        // atomically so the original is not left in the file alongside the
        // re-appended copy. trailingConsumeLength stays unchanged (full span).
        existingTrailingComment = comment;
      }
    }
  }

  return { trailingConsumeLength, existingTrailingComment };
}

export async function discover(opts: {
  dockerfiles?: string;
  dockerhubMirror?: string;
}): Promise<DepRef[]> {
  const files = await discoverViaGlobs({
    inputGlob: opts.dockerfiles,
    defaultPattern: DEFAULT_DOCKERFILE_GLOB_PATTERN,
    label: "docker",
  });

  const deps: DepRef[] = [];

  for (const { file, content } of await readFilesSafe(files, "docker")) {
    let refs;
    try {
      refs = parseDockerfileImagesWithPositions(content);
    } catch {
      // Not a valid Dockerfile, skip
      continue;
    }

    // Pre-compute per-line start offsets for converting line+char to absolute offset
    const lines = content.split("\n");
    const lineStarts = lineStartOffsets(content);

    for (const item of refs) {
      if (item.ref === null) continue;

      const absoluteOffset = lineStarts[item.lineIndex] + item.lineOffset;
      const refLength = item.lineLength;

      // A2: Validate that the computed absoluteOffset actually points to the image ref string.
      // When dockerfile-ast's getImageRange() returns null, the fallback in
      // parseDockerfileImagesWithPositions uses the instruction's start character (typically
      // the "F" of "FROM"), not the image's own character offset. Applying that wrong offset
      // would corrupt the file. Skip with a warning rather than producing a bad rewrite.
      if (content.slice(absoluteOffset, absoluteOffset + refLength) !== item.raw) {
        core.warning(
          `[lisan] docker: skipping ${item.raw} in ${file} — could not determine image range ` +
          `(getImageRange() returned null or position is inconsistent); manual update required`,
        );
        continue;
      }

      // For COPY --from and RUN --mount=from, require positive confirmation that the
      // image exists before treating it as a real external image dependency —
      // confirmCopyMountFromExists is shared with the verify-side gate in
      // src/ecosystems/docker.ts so the two can't drift.
      if (item.source === "copy-from" || item.source === "mount-from") {
        const exists = await confirmCopyMountFromExists(item.ref, opts.dockerhubMirror);
        if (exists !== "found") {
          core.info(
            `[lisan] docker: ${item.raw} not confirmed in registry (${exists}; build context, alias, or typo), skipping`,
          );
          continue;
        }
      }

      // For FROM: reconstruct the trailing AS clause from the parsed build stage name
      // (never slice raw line text — that would capture old "# was" comments on re-runs).
      // For copy-from / mount-from: no trailing content needed.
      const restOfLine = item.source === "from" && item.buildStage != null
        ? ` AS ${item.buildStage}`
        : "";

      // For FROM: number of bytes after the ref to atomically consume in the rewrite,
      // spanning any multi-line continuation up to the instruction's parsed end position.
      // We stop the consume span before any existing trailing "# comment" so it is not
      // destroyed by the rewrite (it will be re-appended verbatim after the "# was" note).
      let trailingConsumeLength = 0;
      let existingTrailingComment = "";
      if (item.source === "from") {
        ({ trailingConsumeLength, existingTrailingComment } = reconcileFromTrailingComment(
          content,
          lineStarts,
          item.instrEndLine,
          item.instrEndChar,
          absoluteOffset,
          refLength,
          item.ref,
        ));
      }

      const instructionOffset = lineStarts[item.instrLineIndex];
      const instrLine = lines[item.instrLineIndex];
      const indent = instrLine.match(/^[ \t]*/)?.[0] ?? "";

      // For copy-from / mount-from: check if a "# was <raw>" annotation for exactly
      // this image already sits on the line(s) immediately above the instruction
      // (idempotency — do not accumulate duplicate "# was" lines on re-runs).
      // Require the payload to equal item.raw exactly so that:
      //   - a "# was other-image:tag" for a different image does NOT suppress
      //     the annotation for this one, and
      //   - a human comment like "# was disabled before" never suppresses anything.
      let hasPrevLineComment = false;
      if (item.source === "copy-from" || item.source === "mount-from") {
        for (let li = item.instrLineIndex - 1; li >= 0; li--) {
          const prevLine = lines[li].trim();
          const prevPayload = prevLine.startsWith("# was ") ? prevLine.slice(6).trim() : "";
          if (prevPayload === item.raw) {
            hasPrevLineComment = true;
            break;
          }
          // Stop scanning once we reach a non-comment line
          if (!prevLine.startsWith("#")) break;
        }
      }

      // The verbatim bytes that will be replaced by this rewrite — used for conflict detection.
      // For FROM the replaced region covers the ref plus the full consumed trailing span
      // (including any trailing comment — trailingConsumeLength always spans absoluteInstrEnd).
      // Any existingTrailingComment is re-appended in buildFileEdits, not left in place.
      const expected = content.slice(absoluteOffset, absoluteOffset + refLength + trailingConsumeLength);

      const position: DockerPosition = {
        raw: item.raw,
        absoluteOffset,
        refLength,
        trailingConsumeLength,
        existingTrailingComment,
        restOfLine,
        isMultiLine: item.source === "from" && item.instrEndLine !== item.instrLineIndex,
        instructionOffset,
        indent,
        hasPrevLineComment,
        source: item.source,
        registry: item.ref.registry,
        repository: item.ref.repository,
        tag: item.ref.tag,
        digest: item.ref.digest,
        file,
        expected,
      };

      deps.push({
        ecosystem: "docker",
        name: makeName(item.ref),
        file,
        current: makeVersion(item.ref),
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
 *   offset = absoluteOffset, length = refLength + trailingConsumeLength
 * (For copy-from / mount-from sources, `trailingConsumeLength` is 0.)
 */
export function rewriteKeyOf(candidate: UpdateCandidate): string | undefined {
  const pos = candidate.dep.position as DockerPosition | null | undefined;
  if (!pos || typeof pos.absoluteOffset !== "number") return undefined;
  return `${pos.absoluteOffset}:${pos.refLength + pos.trailingConsumeLength}`;
}

export function buildFileEdits(
  candidates: UpdateCandidate[],
  style: UpdateStyle,
): FileEdit[] {
  void style; // images are always digest-pinned now; sha/preserve distinction does not apply

  const byFile = groupByFile(candidates);

  const edits: FileEdit[] = [];

  for (const [file, fileCandidates] of byFile) {
    const rewrites: FileEdit["rewrites"] = [];

    // For copy-from / mount-from, group "# was" comments by instructionOffset so that
    // multiple --mount=from images on the same RUN share a single comment block.
    // Map: instructionOffset → { indent, lines in source order }
    const prevLineComments = new Map<number, { indent: string; raws: string[] }>();

    for (const candidate of fileCandidates) {
      const pos = candidate.dep.position as DockerPosition;

      if (!candidate.pinnedTo) {
        // No digest could be resolved — never write a mutable ref. Skip with a warning.
        core.warning(
          `[lisan] docker: skipping ${pos.raw} — could not resolve digest for ` +
          `${candidate.dep.name}:${candidate.latest}; not writing a bare-tag ref`,
        );
        continue;
      }

      const replaced = buildReplacedImageRef(pos.raw, candidate.latest, candidate.pinnedTo);

      if (pos.source === "from" && pos.isMultiLine) {
        // Multi-line FROM instructions (using backslash continuation) cannot be safely
        // rewritten: `restOfLine` only reconstructs the AS clause, not the continuation
        // structure, so applying the rewrite would flatten the instruction. Skip and warn
        // rather than corrupting the user's Dockerfile.
        core.warning(
          `[lisan] docker: skipping ${pos.raw} in ${pos.file} — ` +
          `FROM instruction spans multiple lines (backslash continuation); ` +
          `manual update required`,
        );
        continue;
      }

      if (pos.source === "from") {
        // For FROM, fold the AS clause back before the EOL comment.
        // trailingConsumeLength covers the bytes from after the ref to the end of the
        // instruction (stopping before any existing trailing "#" comment which is
        // re-appended verbatim after the "# was" note).
        const preservedComment = pos.existingTrailingComment
          ? `  ${pos.existingTrailingComment.trim()}`
          : "";
        rewrites.push({
          offset: pos.absoluteOffset,
          length: pos.refLength + pos.trailingConsumeLength,
          replace: `${replaced}${pos.restOfLine}  # was ${pos.raw}${preservedComment}`,
          expected: pos.expected,
        });
      } else {
        // For copy-from / mount-from, pin the ref inline (no trailing comment — the line
        // may have a continuation backslash). Collect the "# was" comment for bulk
        // insertion on the previous line above the enclosing instruction, unless one
        // already exists there (idempotency).
        rewrites.push({ offset: pos.absoluteOffset, length: pos.refLength, replace: replaced, expected: pos.expected });
        if (!pos.hasPrevLineComment) {
          const entry = prevLineComments.get(pos.instructionOffset);
          if (entry) {
            entry.raws.push(pos.raw);
          } else {
            prevLineComments.set(pos.instructionOffset, { indent: pos.indent, raws: [pos.raw] });
          }
        }
      }
    }

    // Emit the grouped previous-line comment inserts (length=0 so they don't displace content).
    // apply.ts sorts descending by offset, placing these before the instruction rewrites.
    for (const [instrOffset, { indent, raws }] of prevLineComments) {
      const commentBlock = raws.map((r) => `${indent}# was ${r}`).join("\n") + "\n";
      rewrites.push({ offset: instrOffset, length: 0, replace: commentBlock, expected: "" });
    }

    if (rewrites.length > 0) {
      edits.push({ file, rewrites });
    }
  }

  return edits;
}
