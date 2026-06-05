/**
 * Unit tests for parseDockerfileImages — pure, network-free.
 */
import { describe, it, expect } from "vitest";
import { parseDockerfileImages } from "../src/ecosystems/docker.js";

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
});
