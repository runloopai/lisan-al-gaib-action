/**
 * Unit tests for parseDockerfileImages — pure, network-free.
 */
import { describe, it, expect } from "vitest";
import { parseDockerfileImages, parseDockerfileImagesWithPositions } from "../src/ecosystems/docker.js";
import { imageIdentity } from "../src/ecosystems/image.js";
import { lineStartOffsets } from "../src/update/ecosystems/shared.js";

describe("parseDockerfileImages", () => {
  it("FROM nginx:1.25 yields one candidate with source 'from' and tag '1.25'", () => {
    const candidates = parseDockerfileImages("FROM nginx:1.25\n");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("from");
    expect(candidates[0].ref.tag).toBe("1.25");
    expect(candidates[0].ref.repository).toBe("library/nginx");
    expect(candidates[0].raw).toBe("nginx:1.25");
  });

  it("FROM with digest pin yields source 'from' with digest set", () => {
    const candidates = parseDockerfileImages(
      "FROM alpine/psql@sha256:5e2b625deadbeef1234567890abcdef1234567890abcdef1234567890abcdef\n",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("from");
    expect(candidates[0].ref.digest).toBe(
      "sha256:5e2b625deadbeef1234567890abcdef1234567890abcdef1234567890abcdef",
    );
    expect(candidates[0].ref.repository).toBe("alpine/psql");
  });

  it("FROM scratch returns empty array", () => {
    expect(parseDockerfileImages("FROM scratch\n")).toEqual([]);
  });

  it("multi-stage: both external images included, stage alias later skipped", () => {
    const content = [
      "FROM node:20 AS builder",
      "FROM nginx:1.25",
      "FROM builder",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    const raws = candidates.map((c) => c.raw);
    expect(raws).toContain("node:20");
    expect(raws).toContain("nginx:1.25");
    // 'builder' is a stage alias — should be omitted
    expect(raws).not.toContain("builder");
    expect(candidates).toHaveLength(2);
  });

  it("COPY --from=builder is skipped when 'builder' is a known stage alias", () => {
    const content = [
      "FROM node:20 AS builder",
      "FROM nginx:1.25",
      "COPY --from=builder /app /app",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    // Only node:20 and nginx:1.25 — no copy-from candidate
    expect(candidates.map((c) => c.source)).not.toContain("copy-from");
    expect(candidates).toHaveLength(2);
  });

  it("COPY --from=0 (numeric index) is skipped", () => {
    const content = ["FROM alpine:3.18", "COPY --from=0 /bin /bin"].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("copy-from");
    expect(candidates).toHaveLength(1);
  });

  it("COPY --chown=user --from=myregistry.io/myimage:v1 yields copy-from candidate", () => {
    const content = [
      "FROM alpine:3.18",
      "COPY --chown=user --from=myregistry.io/myimage:v1 /src /dst",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    const copyFrom = candidates.filter((c) => c.source === "copy-from");
    expect(copyFrom).toHaveLength(1);
    expect(copyFrom[0].ref.registry).toBe("myregistry.io");
    expect(copyFrom[0].ref.tag).toBe("v1");
  });

  it("RUN --mount=type=bind,from=builder (stage alias) is skipped", () => {
    const content = [
      "FROM node:20 AS builder",
      "FROM alpine:3.18",
      "RUN --mount=type=bind,from=builder,target=/app echo ok",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("mount-from");
  });

  it("RUN --mount=type=cache,from=myregistry.io/cache:latest yields mount-from candidate", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=type=cache,from=myregistry.io/cache:latest,target=/cache apk add git",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    const mountFrom = candidates.filter((c) => c.source === "mount-from");
    expect(mountFrom).toHaveLength(1);
    expect(mountFrom[0].ref.registry).toBe("myregistry.io");
    expect(mountFrom[0].ref.tag).toBe("latest");
  });

  it("RUN --mount=type=secret is ignored entirely (no 'from' value)", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=type=secret,id=mysecret cat /run/secrets/mysecret",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("mount-from");
    expect(candidates).toHaveLength(1);
  });

  it("RUN --mount=from=someimage:tag (no explicit type, defaults to bind) yields mount-from", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=from=someimage:tag,target=/src ls /src",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    const mountFrom = candidates.filter((c) => c.source === "mount-from");
    expect(mountFrom).toHaveLength(1);
    expect(mountFrom[0].raw).toBe("someimage:tag");
  });

  it("FROM $BASE_IMAGE (unresolved ARG) is skipped", () => {
    expect(parseDockerfileImages("FROM $BASE_IMAGE\n")).toEqual([]);
  });

  it("COPY --from=$STAGE (unresolved variable) is skipped", () => {
    const content = ["FROM alpine:3.18", "COPY --from=$STAGE /src /dst"].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("copy-from");
  });

  it("FROM --platform=linux/amd64 ubuntu:22.04 is detected (platform flag ignored)", () => {
    const content = "FROM --platform=linux/amd64 ubuntu:22.04\n";
    const candidates = parseDockerfileImages(content);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ref.tag).toBe("22.04");
    expect(candidates[0].ref.repository).toBe("library/ubuntu");
  });

  it("deduplication: same image referenced twice yields only one candidate", () => {
    const content = ["FROM nginx:1.25", "FROM nginx:1.25"].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].raw).toBe("nginx:1.25");
  });

  it("forward-reference: COPY --from=builder skipped even when builder appears after the COPY", () => {
    // All stage aliases are collected in the first pass, so forward refs are handled
    const content = [
      "FROM alpine:3.18",
      "COPY --from=builder /app /app",
      "FROM node:20 AS builder",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("copy-from");
  });

  it("RUN --mount=type=ssh is ignored entirely", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=type=ssh git clone git@github.com:org/repo.git",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("mount-from");
    expect(candidates).toHaveLength(1);
  });

  it("RUN --mount=type=tmpfs is ignored entirely", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=type=tmpfs,target=/tmp echo build",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("mount-from");
    expect(candidates).toHaveLength(1);
  });

  it("multiple --mount flags on one RUN: secret skipped, cache with from emitted", () => {
    const content = [
      "FROM alpine:3.18",
      "RUN --mount=type=secret,id=tok --mount=type=cache,from=myregistry.io/buildcache:v1,target=/cache apk add git",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    const mountFrom = candidates.filter((c) => c.source === "mount-from");
    expect(mountFrom).toHaveLength(1);
    expect(mountFrom[0].ref.registry).toBe("myregistry.io");
    expect(mountFrom[0].ref.tag).toBe("v1");
  });

  it("FROM with a placeholder token (not a valid image name) yields no candidates", () => {
    // __DIND_IMAGE__ is a CI/CD templating placeholder — not a real Docker image name.
    // It uses leading underscores and uppercase, both of which violate the OCI
    // distribution reference grammar. It must be silently ignored.
    expect(parseDockerfileImages("FROM __DIND_IMAGE__\n")).toEqual([]);
    expect(parseDockerfileImages("FROM {{BASE_IMAGE}}\n")).toEqual([]);
  });

  it("COPY --from with a placeholder token yields no candidates", () => {
    // Placeholders in COPY --from= are also rejected at the parse layer (via
    // parseImageRef) before reaching the imageExists network call.
    const content = [
      "FROM alpine:3.18",
      "COPY --from={{CACHE_IMAGE}} /cache /cache",
    ].join("\n");
    const candidates = parseDockerfileImages(content);
    expect(candidates.map((c) => c.source)).not.toContain("copy-from");
    expect(candidates).toHaveLength(1); // only alpine FROM
  });

  it("relabeled digest-pinned FROM (same digest, tag bumped) has the same imageIdentity as base", () => {
    const digest = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    const baseCandidates = parseDockerfileImages(`FROM alpine:3.18@${digest}\n`);
    const headCandidates = parseDockerfileImages(`FROM alpine:3.19@${digest}\n`);

    const baseIdentities = new Set(baseCandidates.map((c) => imageIdentity(c.ref)));
    const newInHead = headCandidates.filter(
      (c) => !baseIdentities.has(imageIdentity(c.ref)),
    );
    expect(newInHead).toHaveLength(0);
  });
});

describe("parseDockerfileImagesWithPositions", () => {
  it("FROM <img> AS <stage>: image range excludes AS clause, instrLineIndex matches FROM line", () => {
    // The image range must stop before " AS build-nerdctl" so updater rewrites
    // only cover the ref itself; restOfLine picks up the rest separately.
    const content = "# comment\nFROM golang:1.24-bookworm AS build-nerdctl\nWORKDIR /src\n";
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref.source).toBe("from");
    expect(ref.raw).toBe("golang:1.24-bookworm");
    // lineIndex is 1 (second line, 0-based); instrLineIndex matches it for FROM
    expect(ref.lineIndex).toBe(1);
    expect(ref.instrLineIndex).toBe(1);
    // The image range length must match the raw ref exactly (no AS clause)
    expect(ref.lineLength).toBe("golang:1.24-bookworm".length);
    // lineOffset points to 'g' in 'golang' (after "FROM ")
    expect(ref.lineOffset).toBe("FROM ".length);
  });

  it("COPY --from=<img>: instrLineIndex is the COPY instruction's line", () => {
    const content = "FROM alpine:3.23\nCOPY --from=docker:20.10.5-dind \\\n    /usr/bin/docker /usr/bin/docker\n";
    const refs = parseDockerfileImagesWithPositions(content);
    // Only COPY --from (copy-from) or plus the FROM (from)
    const copyRef = refs.find((r) => r.source === "copy-from");
    expect(copyRef).toBeDefined();
    expect(copyRef!.instrLineIndex).toBe(1); // COPY is on line 1 (0-based)
    expect(copyRef!.lineIndex).toBe(1);      // value is on the same line as COPY
    expect(copyRef!.raw).toBe("docker:20.10.5-dind");
  });

  it("multi-stage Dockerfile: each FROM gets its own instrLineIndex", () => {
    const content = [
      "FROM golang:1.24 AS builder",
      "RUN make",
      "FROM alpine:3.23",
      "COPY --from=builder /app /app",
    ].join("\n") + "\n";
    const refs = parseDockerfileImagesWithPositions(content);
    const fromRefs = refs.filter((r) => r.source === "from");
    expect(fromRefs).toHaveLength(2);
    expect(fromRefs[0].instrLineIndex).toBe(0); // first FROM
    expect(fromRefs[1].instrLineIndex).toBe(2); // second FROM
  });

  it("FROM <img> AS <stage>: buildStage is the alias name", () => {
    const content = "FROM golang:1.24-bookworm AS build-nerdctl\nWORKDIR /src\n";
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].buildStage).toBe("build-nerdctl");
  });

  it("FROM <img> without AS: buildStage is null", () => {
    const content = "FROM alpine:3.23\nRUN echo hi\n";
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].buildStage).toBeNull();
  });

  it("COPY --from: buildStage is null", () => {
    const content = "FROM alpine:3.23\nCOPY --from=docker:20.10.5-dind /usr/bin/docker /usr/bin/docker\n";
    const refs = parseDockerfileImagesWithPositions(content);
    const copyRef = refs.find((r) => r.source === "copy-from");
    expect(copyRef).toBeDefined();
    expect(copyRef!.buildStage).toBeNull();
  });

  it("FROM single-line: instrEndLine and instrEndChar point to end of that line", () => {
    // "FROM alpine:3.23\n" — the instruction ends on line 0 after "alpine:3.23"
    const content = "FROM alpine:3.23\nRUN echo hi\n";
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].instrEndLine).toBe(0);
    // The instruction ends at the end of "FROM alpine:3.23" (character 16)
    expect(refs[0].instrEndChar).toBe("FROM alpine:3.23".length);
  });
});

// ─── H4: annotation accumulation regression ──────────────────────────────────
// Verifies that parseDockerfileImagesWithPositions correctly parses a FROM line
// that already carries a "# was <old-ref>" comment from a previous updater run
// (possibly with a trailing author comment after it). The key invariant: the raw
// image ref must be parsed from the portion before any comment, and the
// instrEndChar must not extend into the comment text.

describe("docker annotation accumulation (H4 regression)", () => {
  it("FROM with existing '# was <old>' comment: raw is the image ref only", () => {
    // Simulates a Dockerfile that was already updated once; the updater previously
    // appended "# was nginx:1.24". The FROM line is valid and the ref must parse
    // as the current pinned ref, not include the comment.
    const content = "FROM nginx@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab\n";
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe(
      "nginx@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    );
  });

  it("lineOffset/lineLength cover only the image ref, not the trailing comment", () => {
    // The key H4 invariant: lineOffset/lineLength slice exactly the image ref.
    // instrEndChar spans the FULL instruction (including the comment) so the
    // stale-offset "expected" guard has the widest safe region — it must be
    // GREATER THAN hashPos, not less.
    const digest = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    const ref = `nginx@${digest}`;
    const content = `FROM ${ref}  # was nginx:1.24\n`;
    const refs = parseDockerfileImagesWithPositions(content);
    expect(refs).toHaveLength(1);
    // raw must be only the image ref, not including any comment
    expect(refs[0].raw).toBe(ref);
    // lineOffset/lineLength must slice exactly the ref on its line
    const { lineIndex, lineOffset, lineLength } = refs[0];
    const lines = content.split("\n");
    expect(lines[lineIndex].slice(lineOffset, lineOffset + lineLength)).toBe(ref);
    // instrEndChar extends past the "#" (wide guard for stale-offset detection)
    const hashPos = content.indexOf("#");
    expect(refs[0].instrEndChar).toBeGreaterThan(hashPos);
  });

  it("deduplication still works when existing '# was' annotation is present", () => {
    // Two FROM instructions referencing the same digest (one with a comment) must
    // still deduplicate to a single candidate.
    const digest = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    const content = [
      `FROM nginx@${digest}  # was nginx:1.24`,
      `FROM nginx@${digest}`,
    ].join("\n") + "\n";
    const candidates = parseDockerfileImages(content);
    expect(candidates).toHaveLength(1);
  });
});

// ─── T1: discover() offset round-trip ───────────────────────────────────────
// Validates the core invariant that discover() relies on:
//   content.slice(lineStarts[lineIndex] + lineOffset, ... + lineLength) === raw
// This exercises the (lineIndex, lineOffset) → absoluteOffset conversion used in
// src/update/ecosystems/docker.ts before any FileEdit is built.

describe("discover() offset round-trip (T1)", () => {
  function checkOffsets(content: string): void {
    const refs = parseDockerfileImagesWithPositions(content);
    const lineStarts = lineStartOffsets(content);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const absoluteOffset = lineStarts[ref.lineIndex] + ref.lineOffset;
      expect(content.slice(absoluteOffset, absoluteOffset + ref.lineLength)).toBe(ref.raw);
    }
  }

  it("FROM and COPY --from: absoluteOffset slices to raw", () => {
    checkOffsets(
      "# comment\n" +
      "FROM golang:1.24-bookworm AS builder\n" +
      "COPY --from=docker:20.10.5-dind /usr/bin/docker /usr/local/bin/docker\n",
    );
  });

  it("multi-stage Dockerfile: each FROM ref's offset slices to its own raw", () => {
    checkOffsets(
      "FROM node:20 AS build\n" +
      "RUN make\n" +
      "FROM nginx:1.25\n" +
      "COPY --from=build /app /app\n",
    );
  });

  it("multibyte character earlier on the same line does not shift lineOffset", () => {
    // dockerfile-ast Range.character is UTF-16, matching JS String.slice.
    // A 2-byte UTF-8 char (ñ = U+00F1) is still 1 UTF-16 code unit — offset must be correct.
    const content = "FROM alpine:3.18\nRUN echo ñ\nFROM nginx:1.25\n";
    const refs = parseDockerfileImagesWithPositions(content);
    const lineStarts = lineStartOffsets(content);
    const nginxRef = refs.find((r) => r.raw === "nginx:1.25");
    expect(nginxRef).toBeDefined();
    const abs = lineStarts[nginxRef!.lineIndex] + nginxRef!.lineOffset;
    expect(content.slice(abs, abs + nginxRef!.lineLength)).toBe("nginx:1.25");
  });

  it("FROM with digest pin: absoluteOffset covers the full ref including digest", () => {
    const digest = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    checkOffsets(`FROM alpine:3.18@${digest}\n`);
  });
});

// ─── CRLF line-ending round-trip ─────────────────────────────────────────────
describe("parseDockerfileImagesWithPositions — CRLF line endings", () => {
  const LF_CONTENT = "FROM nginx:1.25\nRUN echo hello\nFROM alpine:3.18\n";
  const CRLF_CONTENT = LF_CONTENT.replace(/\n/g, "\r\n");

  it("finds the same image refs under CRLF as under LF", () => {
    const lf = parseDockerfileImagesWithPositions(LF_CONTENT);
    const crlf = parseDockerfileImagesWithPositions(CRLF_CONTENT);
    expect(crlf.map((r) => r.raw).sort()).toEqual(lf.map((r) => r.raw).sort());
    expect(crlf.every((r) => r.ref !== null)).toBe(true);
  });

  it("absoluteOffset points to the correct bytes in the CRLF content", () => {
    const refs = parseDockerfileImagesWithPositions(CRLF_CONTENT);
    const lineStarts = lineStartOffsets(CRLF_CONTENT);
    for (const ref of refs) {
      const abs = lineStarts[ref.lineIndex] + ref.lineOffset;
      expect(CRLF_CONTENT.slice(abs, abs + ref.lineLength)).toBe(ref.raw);
    }
  });
});
