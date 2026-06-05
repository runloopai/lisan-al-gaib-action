import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { DockerfileParser, From, Copy, Run } from "dockerfile-ast";
import type { Flag } from "dockerfile-ast";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import { imageExists } from "../registry.js";
import type { ChangedDep, ParsedImageRef } from "./types.js";
import {
  parseImageRef,
  makeName,
  makeVersion,
  imageIdentity,
  getImagePublishDate,
} from "./image.js";

export interface DockerImageCandidate {
  raw: string;
  ref: ParsedImageRef;
  source: "from" | "copy-from" | "mount-from";
}

/**
 * Parse a Dockerfile (or Containerfile) content and return all external image
 * references found in FROM, COPY --from=, and RUN --mount=...,from= directives.
 *
 * This is a pure, synchronous, network-free function.
 */
export function parseDockerfileImages(content: string): DockerImageCandidate[] {
  const dockerfile = DockerfileParser.parse(content);
  const instructions = dockerfile.getInstructions();

  // Two-pass: first collect all build-stage aliases (lowercased) so that
  // --from references to earlier/later stage names can be filtered out.
  // Forward-reference handling: a COPY --from=alias that appears before
  // FROM ... AS alias is an error in Docker but we still collect all aliases
  // upfront to avoid false positives.
  const stageAliases = new Set<string>();
  for (const instruction of instructions) {
    if (instruction instanceof From) {
      const buildStage = instruction.getBuildStage();
      if (buildStage != null) {
        stageAliases.add(buildStage.toLowerCase());
      }
    }
  }

  // Deduplicate candidates by raw string (first occurrence wins)
  const seen = new Map<string, DockerImageCandidate>();

  function emit(raw: string, source: DockerImageCandidate["source"]): void {
    if (seen.has(raw)) return;
    const ref = parseImageRef(raw);
    if (ref == null) return;
    seen.set(raw, { raw, ref, source });
  }

  // Helper to process a --from flag value (shared between COPY and RUN --mount)
  function processFromValue(
    value: string | null | undefined,
    source: DockerImageCandidate["source"],
  ): void {
    if (value == null || value === "") return;
    if (value.includes("$")) return; // unresolved ARG/ENV variable
    if (stageAliases.has(value.toLowerCase())) return; // build-stage alias
    // Numeric stage index (e.g. "0", "1", "2") — not an image ref
    if (parseInt(value, 10).toString() === value) return;
    emit(value, source);
  }

  // Second pass: process instructions and emit candidates
  for (const instruction of instructions) {
    if (instruction instanceof From) {
      const image = instruction.getImage();
      if (image == null) continue;
      if (image.trim().toLowerCase() === "scratch") continue;
      if (image.includes("$")) continue; // unresolved ARG/ENV variable
      if (stageAliases.has(image.trim().toLowerCase())) continue; // stage alias ref
      emit(image, "from");
      continue;
    }

    if (instruction instanceof Copy) {
      // Use getFlags().find() rather than getFromFlag() to handle cases like
      // COPY --chown=user --from=image (multiple flags on same instruction).
      const fromFlag: Flag | undefined = instruction
        .getFlags()
        .find((f: Flag) => f.getName() === "from");
      if (fromFlag == null) continue;
      processFromValue(fromFlag.getValue(), "copy-from");
      continue;
    }

    if (instruction instanceof Run) {
      const mountFlags: Flag[] = instruction
        .getFlags()
        .filter((f: Flag) => f.getName() === "mount");

      for (const mountFlag of mountFlags) {
        // Only process bind and cache mounts — skip secret, ssh, tmpfs, etc.
        const mountType = mountFlag.getOption("type")?.getValue() ?? null;
        if (mountType != null && mountType !== "bind" && mountType !== "cache") {
          continue;
        }
        const fromValue = mountFlag.getOption("from")?.getValue();
        processFromValue(fromValue, "mount-from");
      }
    }
  }

  return Array.from(seen.values());
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
        const reference = ref.digest ?? ref.tag ?? "latest";
        const exists = await imageExists(ref.registry, ref.repository, reference, dockerhubMirror);
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
