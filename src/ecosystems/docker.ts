import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { DockerfileParser, From, Copy, Run } from "dockerfile-ast";
import type { Flag } from "dockerfile-ast";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import type { ChangedDep, ParsedImageRef } from "./types.js";
import {
  parseImageRef,
  makeName,
  makeVersion,
  imageIdentity,
  getImagePublishDate,
  confirmCopyMountFromExists,
} from "./image.js";

export interface DockerImageCandidate {
  raw: string;
  ref: ParsedImageRef;
  source: "from" | "copy-from" | "mount-from";
}

export interface DockerImageRefWithPos {
  raw: string;            // the raw image string in the source
  ref: ParsedImageRef | null;
  source: "from" | "copy-from" | "mount-from";
  lineIndex: number;      // 0-based line number
  lineOffset: number;     // character offset within line where image ref starts
  lineLength: number;     // length of image ref on that line
  instrLineIndex: number; // 0-based line number of the enclosing instruction's first token
  // FROM-only: the AS <name> stage alias (null when absent).
  buildStage: string | null;
  // The instruction's end position (exclusive), spanning any multi-line continuations.
  // For FROM: used to atomically consume the full instruction span in the rewrite.
  // For copy-from/mount-from: same as the start position (single-line flag value).
  instrEndLine: number;
  instrEndChar: number;
}

/**
 * Parse a Dockerfile (or Containerfile) content and return all external image
 * references found in FROM, COPY --from=, and RUN --mount=...,from= directives.
 *
 * Delegates to parseDockerfileImagesWithPositions (single parse grammar for both
 * the verify and update consumers). First occurrence per raw string wins.
 */
export function parseDockerfileImages(content: string): DockerImageCandidate[] {
  const seen = new Set<string>();
  const results: DockerImageCandidate[] = [];
  for (const { raw, ref, source } of parseDockerfileImagesWithPositions(content)) {
    if (ref === null || seen.has(raw)) continue;
    seen.add(raw);
    results.push({ raw, ref, source });
  }
  return results;
}

/**
 * Parse a Dockerfile/Containerfile and return all external image references
 * with their source-level position info (line index and character offset).
 *
 * Uses the same filtering logic as parseDockerfileImages but additionally
 * captures the exact position of the image ref string using dockerfile-ast's
 * Range API, so callers can perform surgical in-place rewrites.
 */
export function parseDockerfileImagesWithPositions(
  content: string,
): DockerImageRefWithPos[] {
  const dockerfile = DockerfileParser.parse(content);
  const instructions = dockerfile.getInstructions();

  // Collect all build-stage aliases (same logic as parseDockerfileImages)
  const stageAliases = new Set<string>();
  for (const instruction of instructions) {
    if (instruction instanceof From) {
      const buildStage = instruction.getBuildStage();
      if (buildStage != null) {
        stageAliases.add(buildStage.toLowerCase());
      }
    }
  }

  const allRefs: DockerImageRefWithPos[] = [];

  function emit(
    raw: string,
    source: DockerImageRefWithPos["source"],
    lineIndex: number,
    lineOffset: number,
    lineLength: number,
    instrLineIndex: number,
    buildStage: string | null,
    instrEndLine: number,
    instrEndChar: number,
  ): void {
    const ref = parseImageRef(raw);
    if (ref === null) return;
    allRefs.push({ raw, ref, source, lineIndex, lineOffset, lineLength, instrLineIndex, buildStage, instrEndLine, instrEndChar });
  }

  function processFromValue(
    value: string | null | undefined,
    source: DockerImageRefWithPos["source"],
    lineIndex: number,
    lineOffset: number,
    lineLength: number,
    instrLineIndex: number,
    instrEndLine: number,
    instrEndChar: number,
  ): void {
    if (value == null || value === "") return;
    if (value.includes("$")) return;
    if (stageAliases.has(value.toLowerCase())) return;
    if (/^\d+$/.test(value)) return;
    emit(value, source, lineIndex, lineOffset, lineLength, instrLineIndex, null, instrEndLine, instrEndChar);
  }

  for (const instruction of instructions) {
    const instrLineIndex = instruction.getRange().start.line;
    const instrEnd = instruction.getRange().end;

    if (instruction instanceof From) {
      const image = instruction.getImage();
      if (image == null) continue;
      if (image.trim().toLowerCase() === "scratch") continue;
      if (image.includes("$")) continue;
      if (stageAliases.has(image.trim().toLowerCase())) continue;

      const buildStage = instruction.getBuildStage() ?? null;

      const imgRange = instruction.getImageRange();
      if (imgRange == null) {
        // Fallback: use instruction range start as best approximation
        const instRange = instruction.getRange();
        emit(image, "from", instRange.start.line, instRange.start.character, image.length, instrLineIndex, buildStage, instrEnd.line, instrEnd.character);
      } else {
        emit(
          image,
          "from",
          imgRange.start.line,
          imgRange.start.character,
          imgRange.end.character - imgRange.start.character,
          instrLineIndex,
          buildStage,
          instrEnd.line,
          instrEnd.character,
        );
      }
      continue;
    }

    if (instruction instanceof Copy) {
      const fromFlag: Flag | undefined = instruction
        .getFlags()
        .find((f: Flag) => f.getName() === "from");
      if (fromFlag == null) continue;

      const value = fromFlag.getValue();
      const valRange = fromFlag.getValueRange();
      if (valRange != null) {
        processFromValue(
          value,
          "copy-from",
          valRange.start.line,
          valRange.start.character,
          valRange.end.character - valRange.start.character,
          instrLineIndex,
          instrEnd.line,
          instrEnd.character,
        );
      } else {
        // Fallback: use flag range
        const flagRange = fromFlag.getRange();
        processFromValue(
          value,
          "copy-from",
          flagRange.start.line,
          flagRange.start.character + "--from=".length,
          value?.length ?? 0,
          instrLineIndex,
          instrEnd.line,
          instrEnd.character,
        );
      }
      continue;
    }

    if (instruction instanceof Run) {
      const mountFlags: Flag[] = instruction
        .getFlags()
        .filter((f: Flag) => f.getName() === "mount");

      for (const mountFlag of mountFlags) {
        const mountType = mountFlag.getOption("type")?.getValue() ?? null;
        if (mountType != null && mountType !== "bind" && mountType !== "cache") {
          continue;
        }
        const fromOpt = mountFlag.getOption("from");
        const fromValue = fromOpt?.getValue();
        const valRange = fromOpt?.getValueRange ? fromOpt.getValueRange() : null;
        if (valRange != null) {
          processFromValue(
            fromValue,
            "mount-from",
            valRange.start.line,
            valRange.start.character,
            valRange.end.character - valRange.start.character,
            instrLineIndex,
            instrEnd.line,
            instrEnd.character,
          );
        } else if (fromValue != null) {
          // Fallback: best-effort position from mount flag range
          const mountRange = mountFlag.getRange();
          processFromValue(
            fromValue,
            "mount-from",
            mountRange.start.line,
            mountRange.start.character,
            fromValue.length,
            instrLineIndex,
            instrEnd.line,
            instrEnd.character,
          );
        }
      }
    }
  }

  return allRefs;
}

function isDockerfileName(filePath: string): boolean {
  const basename = filePath.includes("/")
    ? filePath.slice(filePath.lastIndexOf("/") + 1)
    : filePath;
  const lower = basename.toLowerCase();
  return lower === "dockerfile" || lower === "containerfile";
}

export async function getChangedDeps(
  baseRef: string,
  dockerfilesInput: string,
  dockerhubMirror?: string,
): Promise<{ deps: ChangedDep[]; imageRefs: Map<string, ParsedImageRef> }> {
  let files: string[];

  if (dockerfilesInput) {
    const allFiles = new Set(await resolveFiles(dockerfilesInput));
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter((f) => allFiles.has(f));
  } else {
    // Auto-detect: any changed file whose basename looks like a Dockerfile
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter(isDockerfileName);
  }

  if (files.length === 0) {
    core.info("docker: no changed Dockerfile/Containerfile files");
    return { deps: [], imageRefs: new Map() };
  }

  const allDeps: ChangedDep[] = [];
  const imageRefs = new Map<string, ParsedImageRef>();

  for (const file of files) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) continue;

    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`docker: could not read ${file}`);
      continue;
    }

    const headCandidates = parseDockerfileImages(headContent);
    if (headCandidates.length === 0) continue; // not a Dockerfile with FROM

    const baseContent = await gitShowFile(baseRef, file);
    const baseCandidates = baseContent
      ? parseDockerfileImages(baseContent)
      : [];

    // Compare by resolved identity (digest), not raw string: a no-op relabel of a
    // digest-pinned image already on base must not be re-flagged.
    const baseIdentities = new Set(baseCandidates.map((c) => imageIdentity(c.ref)));

    for (const candidate of headCandidates) {
      if (baseIdentities.has(imageIdentity(candidate.ref))) continue; // identity already on base

      const { raw, ref, source } = candidate;

      // For COPY --from and RUN --mount=from, require positive confirmation that
      // the image exists before treating it as a real external image dependency.
      // "unknown" (401/429/network error) is also treated as unconfirmed — these
      // sources are ambiguous (build contexts, stage aliases, typos) and we
      // prefer false-negatives over false-positives.
      if (source === "copy-from" || source === "mount-from") {
        const exists = await confirmCopyMountFromExists(ref, dockerhubMirror);
        if (exists !== "found") {
          core.info(
            `docker: ${raw} not confirmed in registry (${exists}; build context, alias, or typo), skipping`,
          );
          continue;
        }
      }

      const name = makeName(ref);
      const version = makeVersion(ref);
      const key = `${name}@${version}`;

      imageRefs.set(key, ref);
      allDeps.push({
        ecosystem: "docker",
        name,
        version,
        file,
      });
    }
  }

  return { deps: allDeps, imageRefs };
}

/**
 * Get the publish date for a Docker image reference.
 * Only digest-pinned (@sha256:...) refs are queried — tag-only refs are
 * mutable and cannot be reliably age-gated, so they return null (unknown).
 */
export async function getPublishDate(
  ref: ParsedImageRef | undefined,
): Promise<Date | null> {
  return getImagePublishDate(ref, "docker");
}
