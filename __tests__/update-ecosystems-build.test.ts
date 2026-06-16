import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  summary: { addRaw: vi.fn(), write: vi.fn() },
}));

import * as core from "@actions/core";

import { selectBazelDepRefs } from "../src/update/ecosystems/bazel.js";
import type { BazelDep, BazelOverride, VersionRef } from "../src/ecosystems/types.js";

import { classifyUpdateLevel } from "../src/update/latest.js";
import { buildFileEdits as buildActionEdits, rewriteKeyOf as actionsRewriteKeyOf } from "../src/update/ecosystems/actions.js";
import type { ActionPosition } from "../src/update/ecosystems/actions.js";

import { buildFileEdits as buildDockerEdits, rewriteKeyOf as dockerRewriteKeyOf, discover as discoverDocker } from "../src/update/ecosystems/docker.js";
import type { DockerPosition } from "../src/update/ecosystems/docker.js";
import * as sharedUpdater from "../src/update/ecosystems/shared.js";
import * as registry from "../src/registry.js";
import { buildFileContent } from "../src/update/apply.js";

import { buildFileEdits as buildK8sEdits, rewriteKeyOf as k8sRewriteKeyOf } from "../src/update/ecosystems/kubernetes.js";
import type { K8sPosition } from "../src/update/ecosystems/kubernetes.js";

import { buildBazelVersionEdits, buildConstantRewrite, pickSemverMin, reconcileConstantRewrites, rewriteKeyOf as bazelRewriteKeyOf } from "../src/update/ecosystems/bazel-shared.js";
import type { BazelVersionPosition } from "../src/update/ecosystems/bazel-shared.js";
import type { VersionRef } from "../src/ecosystems/types.js";

import { buildFileEdits as buildJavaEdits, rewriteKeyOf as javaRewriteKeyOf } from "../src/update/ecosystems/java.js";
import type { JavaArtifactPosition } from "../src/update/ecosystems/java.js";

import type { UpdateCandidate, DepRef } from "../src/update/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeActionCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest?: string;
  pinnedTo?: string;
  matchOffset: number;
  matchLength: number;
  trailingComment?: string | null;
  trailingCommentLength?: number;
  quoteChar?: string | null;
}): UpdateCandidate {
  const file = opts.file ?? "/repo/.github/workflows/ci.yml";
  const position: ActionPosition = {
    raw: `uses: ${opts.name ?? "owner/repo"}@${opts.current ?? "v3"}`,
    matchOffset: opts.matchOffset,
    matchLength: opts.matchLength,
    trailingComment: opts.trailingComment ?? null,
    trailingCommentLength: opts.trailingCommentLength ?? 0,
    quoteChar: opts.quoteChar ?? null,
    file,
  };
  const dep: DepRef = {
    ecosystem: "actions",
    name: opts.name ?? "owner/repo",
    file,
    current: opts.current ?? "v3",
    position,
  };
  return {
    dep,
    latest: opts.latest ?? "v4",
    pinnedTo: opts.pinnedTo,
    updateLevel: "major",
    publishDate: null,
    ageDays: null,
    breaking: true,
  };
}

function makeDockerCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest?: string;
  pinnedTo?: string;
  raw: string;
  absoluteOffset: number;
  refLength: number;
  trailingConsumeLength?: number;
  existingTrailingComment?: string;
  expected?: string;
  restOfLine?: string;
  instructionOffset?: number;
  indent?: string;
  hasPrevLineComment?: boolean;
  isMultiLine?: boolean;
  source?: "from" | "copy-from" | "mount-from";
  registry?: string;
  repository?: string;
  tag?: string | null;
  digest?: string | null;
}): UpdateCandidate {
  const file = opts.file ?? "/repo/Dockerfile";
  const raw = opts.raw;
  const refLength = opts.refLength;
  const trailingConsumeLength = opts.trailingConsumeLength ?? 0;
  const position: DockerPosition = {
    raw,
    absoluteOffset: opts.absoluteOffset,
    refLength,
    trailingConsumeLength,
    existingTrailingComment: opts.existingTrailingComment ?? "",
    expected: opts.expected ?? raw,
    restOfLine: opts.restOfLine ?? "",
    isMultiLine: opts.isMultiLine ?? false,
    instructionOffset: opts.instructionOffset ?? opts.absoluteOffset,
    indent: opts.indent ?? "",
    hasPrevLineComment: opts.hasPrevLineComment ?? false,
    source: opts.source ?? "from",
    registry: opts.registry ?? "docker.io",
    repository: opts.repository ?? "library/nginx",
    tag: opts.tag ?? "1.20",
    digest: opts.digest ?? null,
    file,
  };
  const dep: DepRef = {
    ecosystem: "docker",
    name: opts.name ?? "nginx",
    file,
    current: opts.current ?? "1.20",
    position,
  };
  return {
    dep,
    latest: opts.latest ?? "1.21",
    pinnedTo: opts.pinnedTo,
    updateLevel: "minor",
    publishDate: null,
    ageDays: null,
    breaking: false,
  };
}

function makeK8sCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest?: string;
  pinnedTo?: string;
  raw: string;
  absoluteOffset: number;
  refLength: number;
  registry?: string;
  repository?: string;
  tag?: string | null;
  digest?: string | null;
}): UpdateCandidate {
  const file = opts.file ?? "/repo/k8s/deploy.yaml";
  const position: K8sPosition = {
    raw: opts.raw,
    absoluteOffset: opts.absoluteOffset,
    refLength: opts.refLength,
    registry: opts.registry ?? "docker.io",
    repository: opts.repository ?? "library/nginx",
    tag: opts.tag ?? "1.20",
    digest: opts.digest ?? null,
    file,
  };
  const dep: DepRef = {
    ecosystem: "kubernetes",
    name: opts.name ?? "nginx",
    file,
    current: opts.current ?? "1.20",
    position,
  };
  return {
    dep,
    latest: opts.latest ?? "1.21",
    pinnedTo: opts.pinnedTo,
    updateLevel: "minor",
    publishDate: null,
    ageDays: null,
    breaking: false,
  };
}

function makeBazelCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest?: string;
  versionNodeStart: number;
  versionNodeEnd: number;
  versionPrefix?: string;
  ecosystem?: "rust" | "bazel";
}): UpdateCandidate {
  const file = opts.file ?? "/repo/MODULE.bazel";
  const position: BazelVersionPosition = {
    versionRef: {
      value: opts.current ?? "1.0.150",
      nodeStart: opts.versionNodeStart,
      nodeEnd: opts.versionNodeEnd,
      templatePrefix: "",
      templateSuffix: "",
    },
    file,
    versionPrefix: opts.versionPrefix,
  };
  const dep: DepRef = {
    ecosystem: opts.ecosystem ?? "rust",
    name: opts.name ?? "serde",
    file,
    current: opts.current ?? "1.0.150",
    position,
  };
  return {
    dep,
    latest: opts.latest ?? "1.0.200",
    updateLevel: "patch",
    publishDate: null,
    ageDays: null,
    breaking: false,
  };
}

function makeJavaCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest?: string;
  artifactRaw: string;
}): UpdateCandidate {
  const file = opts.file ?? "/repo/MODULE.bazel";
  const position: JavaArtifactPosition = {
    artifactRaw: opts.artifactRaw,
    file,
  };
  const dep: DepRef = {
    ecosystem: "java",
    name: opts.name ?? "com.google.guava:guava",
    file,
    current: opts.current ?? "31.1-jre",
    position,
  };
  return {
    dep,
    latest: opts.latest ?? "32.0.0-jre",
    updateLevel: "major",
    publishDate: null,
    ageDays: null,
    breaking: true,
  };
}

// ─── Actions buildFileEdits ──────────────────────────────────────────────────

describe("actions buildFileEdits", () => {
  it("sha style, no trailing comment: offset covers match, replace is uses:@sha with # tag", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: "abc123def456",
      matchOffset: 10,
      matchLength: 26,  // length of "uses: owner/repo@v3"
      trailingCommentLength: 0,
    });

    const edits = buildActionEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(1);

    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.offset).toBe(10);
    expect(rewrite.length).toBe(26);
    expect(rewrite.replace).toBe("uses: owner/repo@abc123def456  # v4");
  });

  it("sha style, with trailing comment: length extends to cover existing comment", () => {
    // Trailing comment "  # v3" has length 6
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: "abc123def456",
      matchOffset: 0,
      matchLength: 20,
      trailingComment: "# v3",
      trailingCommentLength: 6,
    });

    const edits = buildActionEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // length must include both matchLength and trailingCommentLength
    expect(rewrite.length).toBe(20 + 6);
    // sha style: new comment is # latestTag
    expect(rewrite.replace).toBe("uses: owner/repo@abc123def456  # v4");
  });

  it("preserve style: version-like trailing comment is updated to the new version", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: undefined,
      matchOffset: 0,
      matchLength: 20,
      trailingComment: "# v3",
      trailingCommentLength: 6,
    });

    const edits = buildActionEdits([candidate], "preserve");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // version-like comment ("# v3") is synced to the new version, not left stale
    expect(rewrite.replace).toBe("uses: owner/repo@v4  # v4");
  });

  it("preserve style: non-version trailing comment is re-appended unchanged", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: undefined,
      matchOffset: 0,
      matchLength: 20,
      trailingComment: "# pinned for stability",
      trailingCommentLength: 24,
    });

    const edits = buildActionEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("uses: owner/repo@v4  # pinned for stability");
  });

  it("preserve style, no trailing comment: replace is uses:@latest without comment", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      matchOffset: 5,
      matchLength: 20,
      trailingComment: null,
      trailingCommentLength: 0,
    });

    const edits = buildActionEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("uses: owner/repo@v4");
  });

  it("P1: preserve style refuses to unpin an already-SHA-pinned action to a tag", () => {
    const candidate = makeActionCandidate({
      name: "actions/checkout",
      current: "abc123def456abc123def456abc123def456abc1", // 40-hex commit SHA
      latest: "v4",
      pinnedTo: undefined,
      matchOffset: 0,
      matchLength: 20,
      trailingComment: "# v3.1.0",
      trailingCommentLength: 8,
    });

    const edits = buildActionEdits([candidate], "preserve");
    // No rewrite should be emitted — the SHA pin must be left untouched, not
    // downgraded to a mutable tag.
    expect(edits).toHaveLength(0);
  });

  it("preserve style still updates a tag-pinned action (not SHA-pinned)", () => {
    const candidate = makeActionCandidate({
      name: "actions/checkout",
      current: "v3",
      latest: "v4",
      pinnedTo: undefined,
      matchOffset: 0,
      matchLength: 20,
      trailingComment: null,
      trailingCommentLength: 0,
    });

    const edits = buildActionEdits([candidate], "preserve");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };
    expect(rewrite.replace).toBe("uses: actions/checkout@v4");
  });

  it("multiple candidates from same file: produces single FileEdit with multiple rewrites", () => {
    const file = "/repo/.github/workflows/ci.yml";
    const c1 = makeActionCandidate({
      file,
      name: "actions/checkout",
      current: "v3",
      latest: "v4",
      pinnedTo: "sha1abc",
      matchOffset: 10,
      matchLength: 30,
    });
    const c2 = makeActionCandidate({
      file,
      name: "actions/setup-node",
      current: "v3",
      latest: "v4",
      pinnedTo: "sha2def",
      matchOffset: 60,
      matchLength: 34,
    });

    const edits = buildActionEdits([c1, c2], "sha");
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe(file);
    expect(edits[0].rewrites).toHaveLength(2);
  });

  it("candidates from different files: returns multiple FileEdits", () => {
    const c1 = makeActionCandidate({
      file: "/repo/.github/workflows/ci.yml",
      name: "actions/checkout",
      matchOffset: 0,
      matchLength: 30,
    });
    const c2 = makeActionCandidate({
      file: "/repo/.github/workflows/deploy.yml",
      name: "actions/checkout",
      matchOffset: 0,
      matchLength: 30,
    });

    const edits = buildActionEdits([c1, c2], "preserve");
    expect(edits).toHaveLength(2);
    const files = edits.map((e) => e.file).sort();
    expect(files[0]).toBe("/repo/.github/workflows/ci.yml");
    expect(files[1]).toBe("/repo/.github/workflows/deploy.yml");
  });
});

// ─── Docker buildFileEdits ───────────────────────────────────────────────────

describe("docker buildFileEdits", () => {
  it("sha style, FROM instruction: preserves raw prefix, appends @digest, adds # was comment", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 5,
      refLength: 10,
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:deadbeef",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.offset).toBe(5);
    expect(rewrite.length).toBe(10);
    // Should contain new tag, digest, and old ref comment
    expect(rewrite.replace).toBe("nginx:1.21@sha256:deadbeef  # was nginx:1.20");
  });

  it("no pinnedTo: skipped — never writes a mutable bare-tag ref", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 5,
      refLength: 10,
      source: "from",
      latest: "1.21",
      pinnedTo: undefined,
    });

    const edits = buildDockerEdits([candidate], "preserve");
    // No rewrite produced when pinnedTo is absent — mutable refs are never written
    expect(edits).toHaveLength(0);
  });

  it("Docker Hub library image: preserves raw prefix with digest", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 0,
      refLength: 10,
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.20",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildDockerEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("nginx:1.21@sha256:abc123  # was nginx:1.20");
  });

  it("Docker Hub user image: preserves raw prefix with digest, prev-line comment inserted", () => {
    const candidate = makeDockerCandidate({
      raw: "user/myapp:1.20",
      absoluteOffset: 50,
      refLength: 15,
      instructionOffset: 20,
      indent: "",
      registry: "docker.io",
      repository: "user/myapp",
      tag: "1.20",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
      source: "copy-from",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    expect(rewrites).toHaveLength(2);

    const inline = rewrites.find((r) => r.offset === 50)!;
    expect(inline.replace).toBe("user/myapp:1.21@sha256:abc123");

    const prevLine = rewrites.find((r) => r.offset === 20)!;
    expect(prevLine.length).toBe(0);
    expect(prevLine.replace).toBe("# was user/myapp:1.20\n");
  });

  it("custom registry: preserves full registry prefix with digest, prev-line comment inserted", () => {
    const candidate = makeDockerCandidate({
      raw: "registry.example.com/myrepo:1.20",
      absoluteOffset: 60,
      refLength: 32,
      instructionOffset: 20,
      indent: "",
      registry: "registry.example.com",
      repository: "myrepo",
      tag: "1.20",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
      source: "copy-from",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    expect(rewrites).toHaveLength(2);

    const inline = rewrites.find((r) => r.offset === 60)!;
    expect(inline.replace).toBe("registry.example.com/myrepo:1.21@sha256:abc123");

    const prevLine = rewrites.find((r) => r.offset === 20)!;
    expect(prevLine.length).toBe(0);
    expect(prevLine.replace).toBe("# was registry.example.com/myrepo:1.20\n");
  });

  it("FROM with trailing AS <stage>: stage name is preserved outside the # was comment", () => {
    // Regression: previously the comment was inserted right after the image ref,
    // so " AS build-nerdctl" would end up inside the # comment and the build stage
    // would be silently dropped. The rewrite must cover the entire ref+trailing tokens
    // and re-emit them before the comment.
    const asClause = " AS build-nerdctl";
    const candidate = makeDockerCandidate({
      raw: "golang:1.24-bookworm",
      absoluteOffset: 5,
      refLength: 20,
      // trailingConsumeLength drives the rewrite length; restOfLine is the replacement content
      trailingConsumeLength: asClause.length,
      restOfLine: asClause,
      instructionOffset: 0,
      source: "from",
      latest: "1.24-bookworm",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // length = refLength + trailingConsumeLength, covering the AS clause span
    expect(rewrite.length).toBe(20 + asClause.length);
    // AS clause must come before the # was comment, not inside it
    expect(rewrite.replace).toBe(
      "golang:1.24-bookworm@sha256:abc123 AS build-nerdctl  # was golang:1.24-bookworm",
    );
    expect(rewrite.replace).not.toMatch(/# was.*AS/);
  });

  it("FROM without trailing tokens: output identical to plain EOL comment", () => {
    // When restOfLine is empty, the folded splice collapses to the original behaviour.
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 5,
      refLength: 10,
      restOfLine: "",
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:deadbeef",
    });

    const edits = buildDockerEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.length).toBe(10);
    expect(rewrite.replace).toBe("nginx:1.21@sha256:deadbeef  # was nginx:1.20");
  });

  it("copy-from instruction: inline ref replaced without # was, prev-line comment inserted", () => {
    // COPY --from lines have a continuation backslash, so the comment must go on the
    // line above (instructionOffset), not inline after the ref.
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      // absoluteOffset is the position of "nginx:1.20" inside "--from=nginx:1.20"
      absoluteOffset: 100,
      refLength: 10,
      instructionOffset: 80, // start of the COPY line
      indent: "",
      source: "copy-from",
      latest: "1.21",
      pinnedTo: "sha256:deadbeef",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    expect(rewrites).toHaveLength(2);

    // Inline rewrite: pin ref, no comment
    const inline = rewrites.find((r) => r.offset === 100)!;
    expect(inline.length).toBe(10);
    expect(inline.replace).toBe("nginx:1.21@sha256:deadbeef");
    expect(inline.replace).not.toContain("# was");

    // Previous-line insert: length 0, comment block above the COPY instruction
    const prevLine = rewrites.find((r) => r.offset === 80)!;
    expect(prevLine.length).toBe(0);
    expect(prevLine.replace).toBe("# was nginx:1.20\n");
  });

  it("mount-from instruction: inline ref replaced without # was, prev-line comment inserted", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 200,
      refLength: 10,
      instructionOffset: 150, // start of the RUN line
      indent: "  ",
      source: "mount-from",
      latest: "1.21",
      pinnedTo: "sha256:cafebabe",
    });

    const edits = buildDockerEdits([candidate], "sha");
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    expect(rewrites).toHaveLength(2);

    const inline = rewrites.find((r) => r.offset === 200)!;
    expect(inline.replace).toBe("nginx:1.21@sha256:cafebabe");
    expect(inline.replace).not.toContain("# was");

    const prevLine = rewrites.find((r) => r.offset === 150)!;
    expect(prevLine.length).toBe(0);
    expect(prevLine.replace).toBe("  # was nginx:1.20\n");
  });

  it("copy-from with hasPrevLineComment: inline ref pinned, no second prev-line comment", () => {
    // Idempotency: if "# was <raw>" already exists above the COPY instruction from a
    // prior run, do not insert another one.
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 100,
      refLength: 10,
      instructionOffset: 80,
      indent: "",
      hasPrevLineComment: true,
      source: "copy-from",
      latest: "1.21",
      pinnedTo: "sha256:deadbeef",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    // Only the inline ref replace — no prev-line insert
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].offset).toBe(100);
    expect(rewrites[0].replace).toBe("nginx:1.21@sha256:deadbeef");
  });

  it("RUN with two --mount=from images: single combined comment block above the instruction", () => {
    // Both mount-from refs share the same instructionOffset (same RUN instruction).
    // They should produce ONE length-0 insert with both # was lines, in source order.
    const file = "/repo/Dockerfile";
    const c1 = makeDockerCandidate({
      file,
      raw: "base:1.0",
      absoluteOffset: 310,
      refLength: 8,
      instructionOffset: 280,
      indent: "",
      source: "mount-from",
      name: "base",
      current: "1.0",
      latest: "2.0",
      pinnedTo: "sha256:aaa",
    });
    const c2 = makeDockerCandidate({
      file,
      raw: "cache:1.0",
      absoluteOffset: 360,
      refLength: 9,
      instructionOffset: 280, // same RUN instruction
      indent: "",
      source: "mount-from",
      name: "cache",
      current: "1.0",
      latest: "2.0",
      pinnedTo: "sha256:bbb",
    });

    const edits = buildDockerEdits([c1, c2], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    // 2 inline ref rewrites + 1 shared prev-line insert
    expect(rewrites).toHaveLength(3);

    const prevLines = rewrites.filter((r) => r.length === 0);
    expect(prevLines).toHaveLength(1);
    expect(prevLines[0].offset).toBe(280);
    // Combined block: both raws in source order
    expect(prevLines[0].replace).toBe("# was base:1.0\n# was cache:1.0\n");
  });

  it("sha style: replaces existing tag and digest, # was comment shows old full ref", () => {
    // buildReplacedImageRef strips the old digest from raw before adding the new one.
    // The # was comment is the full original raw ref (including old digest).
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20@sha256:olddigest",
      absoluteOffset: 0,
      refLength: 26,
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:newdigest",
    });

    const edits = buildDockerEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // The new image ref should use the new tag + new digest
    expect(rewrite.replace).toContain("nginx:1.21@sha256:newdigest");
    // The "# was" suffix records the original raw ref in full
    expect(rewrite.replace).toBe("nginx:1.21@sha256:newdigest  # was nginx:1.20@sha256:olddigest");
  });

  it("FROM re-run with bare base image: '# was alpine' is treated as a human comment and preserved", () => {
    // Bare tokens like `alpine` contain no ":" or "@", so the updated heuristic no longer
    // classifies them as prior tool-injected annotations. Instead, discover() preserves
    // them verbatim in existingTrailingComment (trailingConsumeLength stops before the "#").
    // buildFileEdits must re-append the human comment after the new "# was" annotation,
    // producing: `<new-ref>  # was <old-ref>  # was alpine`
    const candidate = makeDockerCandidate({
      raw: "alpine@sha256:OLD",
      absoluteOffset: 5,
      refLength: 17,
      trailingConsumeLength: 2,             // only the two spaces before "#" are consumed
      existingTrailingComment: "# was alpine",  // bare name preserved as human comment
      expected: "alpine@sha256:OLD  ",
      source: "from",
      name: "alpine",
      latest: "latest",
      pinnedTo: "sha256:NEW",
      tag: "latest",
      digest: "sha256:OLD",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };
    // The human "# was alpine" comment is re-appended after the new "# was" annotation.
    expect(rewrite.replace).toBe("alpine:latest@sha256:NEW  # was alpine@sha256:OLD  # was alpine");
    expect(rewrite.replace.match(/# was/g)).toHaveLength(2);
  });

  it("FROM re-run: existing '# was' annotation consumed; new '# was' does not accumulate", () => {
    // Simulates a second run where the upstream digest changed after the first pin.
    // discover() detects the existing "# was nginx:1.20" as a previously-injected
    // annotation and consumes it (trailingConsumeLength covers the full comment span,
    // existingTrailingComment is empty). buildFileEdits must produce exactly ONE
    // "# was <current>" annotation with no duplicate or mangled leftover.
    const candidate = makeDockerCandidate({
      raw: "nginx:1.21@sha256:OLD",
      absoluteOffset: 5,
      refLength: 21,
      // trailingConsumeLength spans "  # was nginx:1.20" (18 chars) — consumed, not preserved
      trailingConsumeLength: 18,
      existingTrailingComment: "", // previously-injected annotation stripped by discover()
      expected: "nginx:1.21@sha256:OLD  # was nginx:1.20",
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:NEW",
      tag: "1.21",
      digest: "sha256:OLD",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };

    // The replacement should carry exactly one "# was" annotation for the current ref
    expect(rewrite.replace).toBe("nginx:1.21@sha256:NEW  # was nginx:1.21@sha256:OLD");
    // Must not contain a second "# was nginx:1.20" (the old consumed annotation)
    expect(rewrite.replace).not.toContain("# was nginx:1.20");
    // The consumed length must include the full old annotation span
    expect(rewrite.length).toBe(21 + 18); // refLength + trailingConsumeLength
  });

  it("FROM with genuine author comment: comment appears exactly once (regression for double-comment bug)", () => {
    // Regression: discover() previously set trailingConsumeLength = hashIdx (stopping BEFORE
    // the '#'), so the original comment was left in the file AND re-appended via
    // existingTrailingComment → double comment on every run.
    // After the fix, trailingConsumeLength spans absoluteInstrEnd (includes the comment bytes),
    // so the rewrite atomically replaces the full region and re-appends the comment once.
    //
    // Simulated file content after ref: "  # pinned for CVE-1234" (23 chars)
    const authorComment = "# pinned for CVE-1234";
    const trailingConsumeLength = 2 + authorComment.length; // 2 spaces + comment
    const raw = "alpine:3.18@sha256:OLD";
    const candidate = makeDockerCandidate({
      raw,
      absoluteOffset: 5,
      refLength: raw.length,
      // New discover() semantics: trailingConsumeLength covers the full span (including comment)
      trailingConsumeLength,
      existingTrailingComment: authorComment,
      expected: raw + "  " + authorComment, // full span including the comment
      source: "from",
      name: "alpine",
      latest: "3.18",
      pinnedTo: "sha256:NEW",
      tag: "3.18",
      digest: "sha256:OLD",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };

    // Length must cover the full span (ref + spaces + comment bytes)
    expect(rewrite.length).toBe(raw.length + trailingConsumeLength);

    // Comment must appear exactly once in the replace string
    const commentCount = (rewrite.replace.match(/# pinned for CVE-1234/g) ?? []).length;
    expect(commentCount).toBe(1);

    // Replace string has the correct structure: new-ref  # was old-ref  # author-comment
    expect(rewrite.replace).toBe(
      `alpine:3.18@sha256:NEW  # was ${raw}  ${authorComment}`,
    );
  });

  it("FROM re-run with author comment after '# was': author comment appears exactly once", () => {
    // Second-run case: discover() detects "# was nginx:1.20" as a prior annotation and
    // captures any trailing "  # author-comment" into existingTrailingComment. The fix
    // ensures trailingConsumeLength covers the full span (through the author comment),
    // so the rewrite replaces everything atomically and the comment appears once.
    //
    // File content after ref: "  # was nginx:1.20  # pinned" (28 chars)
    const wasAnnotation = "# was nginx:1.20";
    const authorPart = "# pinned";
    const trailingConsumeLength = 2 + wasAnnotation.length + 2 + authorPart.length; // 28
    const raw = "nginx:1.21@sha256:OLD";
    const candidate = makeDockerCandidate({
      raw,
      absoluteOffset: 5,
      refLength: raw.length,
      trailingConsumeLength,
      existingTrailingComment: authorPart,
      expected: `${raw}  ${wasAnnotation}  ${authorPart}`,
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:NEW",
      tag: "1.21",
      digest: "sha256:OLD",
    });

    const edits = buildDockerEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };

    // Full span consumed
    expect(rewrite.length).toBe(raw.length + trailingConsumeLength);

    // Author comment appears exactly once; old "# was nginx:1.20" does not appear
    const pinnedCount = (rewrite.replace.match(/# pinned/g) ?? []).length;
    expect(pinnedCount).toBe(1);
    expect(rewrite.replace).not.toContain(wasAnnotation);

    // New "# was current" annotation present once
    const wasCount = (rewrite.replace.match(/# was /g) ?? []).length;
    expect(wasCount).toBe(1);
    expect(rewrite.replace).toContain(`# was ${raw}`);
  });

  it("H2: isMultiLine FROM is skipped with a warning — no edits produced", () => {
    // Multi-line FROM instructions (backslash continuation) cannot be safely rewritten
    // because restOfLine only reconstructs the AS clause, not the continuation structure.
    // The fix (H2): detect via isMultiLine and skip rather than flatten.
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const candidate = makeDockerCandidate({
      raw: "golang:1.24",
      absoluteOffset: 5,
      refLength: 11,
      source: "from",
      isMultiLine: true,
      latest: "1.25",
      pinnedTo: "sha256:abc123",
    });
    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("spans multiple lines"));
    warnSpy.mockRestore();
  });

  it("M3: prose comment '# was on alpine:3 before' is re-appended verbatim (not consumed as annotation)", () => {
    // Regression: the old heuristic matched ":" in the comment payload and classified
    // "# was on alpine:3 before" as a previously-injected annotation, silently consuming it.
    // The fix requires the payload to be a single whitespace-free token; prose with spaces fails
    // that check and is preserved as existingTrailingComment. buildFileEdits must re-append it.
    const authorComment = "# was on alpine:3 before";
    const candidate = makeDockerCandidate({
      raw: "alpine:3.18",
      absoluteOffset: 5,
      refLength: 11,
      trailingConsumeLength: 2 + authorComment.length, // "  # was on alpine:3 before"
      existingTrailingComment: authorComment,
      expected: `alpine:3.18  ${authorComment}`,
      source: "from",
      latest: "3.19",
      pinnedTo: "sha256:NEW",
      tag: "3.18",
      digest: null,
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };

    // The replace string must contain the new tool-injected annotation…
    expect(rewrite.replace).toContain("# was alpine:3.18");
    // …AND the original human prose comment re-appended after it.
    expect(rewrite.replace).toContain(authorComment);
    // Exact structure: <new-ref>  # was <old-ref>  # was on alpine:3 before
    expect(rewrite.replace).toBe(
      `alpine:3.19@sha256:NEW  # was alpine:3.18  ${authorComment}`,
    );
  });

  it("M3: copy-from with unrelated '# was other-image' above: new comment IS inserted (not suppressed)", () => {
    // Regression: the old back-scan checked for ":" or "@" anywhere in the previous
    // comment payload, so "# was other-image:tag" above a COPY --from=current-image:v2
    // falsely set hasPrevLineComment=true and suppressed the correct annotation.
    // The fix requires an EXACT match: prevPayload === item.raw.
    // Here hasPrevLineComment is false (the prior comment is for a different image),
    // so buildFileEdits must produce a prev-line insert for the current image.
    const candidate = makeDockerCandidate({
      raw: "current-image:v2",
      absoluteOffset: 100,
      refLength: 16,
      instructionOffset: 70,
      indent: "",
      hasPrevLineComment: false, // discover() correctly left this false after the fix
      source: "copy-from",
      latest: "v3",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;

    // Both an inline ref rewrite and a prev-line comment insert must be present.
    expect(rewrites).toHaveLength(2);
    const prevLine = rewrites.find((r) => r.offset === 70)!;
    expect(prevLine.length).toBe(0);
    expect(prevLine.replace).toBe("# was current-image:v2\n");
  });
});

// ─── Kubernetes buildFileEdits ───────────────────────────────────────────────

describe("kubernetes buildFileEdits", () => {
  it("uses absoluteOffset and refLength as offset-based rewrite", () => {
    const candidate = makeK8sCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 42,
      refLength: 10,
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildK8sEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.offset).toBe(42);
    expect(rewrite.length).toBe(10);
  });

  it("no pinnedTo: skipped — never writes a mutable bare-tag ref", () => {
    const candidate = makeK8sCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 0,
      refLength: 10,
      latest: "1.21",
    });

    const edits = buildK8sEdits([candidate], "preserve");
    expect(edits).toHaveLength(0);
  });

  it("preserves registry prefix from raw ref when pinned", () => {
    const candidate = makeK8sCandidate({
      raw: "registry.example.com/myrepo:1.20",
      absoluteOffset: 0,
      refLength: 32,
      registry: "registry.example.com",
      repository: "myrepo",
      tag: "1.20",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildK8sEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("registry.example.com/myrepo:1.21@sha256:abc123");
  });

  it("sha style: includes digest in replacement", () => {
    const candidate = makeK8sCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 0,
      refLength: 10,
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildK8sEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("nginx:1.21@sha256:abc123");
  });

  it("multiple candidates from same file: grouped into one FileEdit", () => {
    const file = "/repo/k8s/deploy.yaml";
    const c1 = makeK8sCandidate({ file, raw: "nginx:1.20", absoluteOffset: 10, refLength: 10, pinnedTo: "sha256:abc" });
    const c2 = makeK8sCandidate({ file, raw: "redis:6.0", absoluteOffset: 80, refLength: 9, pinnedTo: "sha256:def", name: "redis", current: "6.0", latest: "6.2" });

    const edits = buildK8sEdits([c1, c2], "sha");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(2);
  });

  it("candidates from different files: returns multiple FileEdits", () => {
    const c1 = makeK8sCandidate({ file: "/repo/k8s/a.yaml", raw: "nginx:1.20", absoluteOffset: 0, refLength: 10, pinnedTo: "sha256:abc" });
    const c2 = makeK8sCandidate({ file: "/repo/k8s/b.yaml", raw: "nginx:1.20", absoluteOffset: 0, refLength: 10, pinnedTo: "sha256:abc" });

    const edits = buildK8sEdits([c1, c2], "sha");
    expect(edits).toHaveLength(2);
  });
});

// ─── Rust/Bazel buildBazelVersionEdits ──────────────────────────────────────

describe("buildBazelVersionEdits (bazel-shared)", () => {
  it("single crate: offset = versionNodeStart - 1, length = end - start + 2, replace = quoted version", async () => {
    // Simulate: crate.spec(package="serde", version="1.0.150")
    // Suppose the version string node spans bytes 40..47 (the content "1.0.150", 7 chars)
    // versionNodeStart = 40 (start of content inside quotes, after opening quote at 39)
    // versionNodeEnd = 47 (end of content inside quotes, before closing quote at 47)
    // The quoted string: offset = 40-1 = 39, length = 47-40+2 = 9 (includes both quotes)
    const candidate = makeBazelCandidate({
      versionNodeStart: 40,
      versionNodeEnd: 47,
      latest: "1.2.3",
    });

    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.offset).toBe(39);       // versionNodeStart - 1
    expect(rewrite.length).toBe(9);        // versionNodeEnd - versionNodeStart + 2
    expect(rewrite.replace).toBe('"1.2.3"');
  });

  it("rust crate with = prefix: prefix is preserved in rewrite", async () => {
    const candidate = makeBazelCandidate({
      versionNodeStart: 40,
      versionNodeEnd: 47,
      versionPrefix: "=",
      latest: "1.2.3",
      ecosystem: "rust",
    });

    const edits = await buildBazelVersionEdits([candidate]);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // Offset/length unchanged: the span still covers the whole original literal
    expect(rewrite.offset).toBe(39);
    expect(rewrite.length).toBe(9);
    expect(rewrite.replace).toBe('"=1.2.3"');
  });

  it("rust crate with ^ prefix: prefix is preserved in rewrite", async () => {
    const candidate = makeBazelCandidate({
      versionNodeStart: 40,
      versionNodeEnd: 47,
      versionPrefix: "^",
      latest: "1.2.3",
      ecosystem: "rust",
    });

    const edits = await buildBazelVersionEdits([candidate]);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('"^1.2.3"');
  });

  it("rust crate with >= prefix: prefix is preserved in rewrite", async () => {
    const candidate = makeBazelCandidate({
      versionNodeStart: 40,
      versionNodeEnd: 47,
      versionPrefix: ">=",
      latest: "1.2.3",
      ecosystem: "rust",
    });

    const edits = await buildBazelVersionEdits([candidate]);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('">=1.2.3"');
  });

  it("bazel_dep (no prefix): versionPrefix absent produces plain version", async () => {
    const candidate = makeBazelCandidate({
      versionNodeStart: 40,
      versionNodeEnd: 47,
      versionPrefix: undefined,
      latest: "1.2.3",
      ecosystem: "bazel",
    });

    const edits = await buildBazelVersionEdits([candidate]);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('"1.2.3"');
  });

  it("multiple crates in same file: produces one FileEdit with multiple rewrites", async () => {
    const file = "/repo/MODULE.bazel";
    const c1 = makeBazelCandidate({ file, name: "serde", versionNodeStart: 40, versionNodeEnd: 47, latest: "1.2.3" });
    const c2 = makeBazelCandidate({ file, name: "tokio", versionNodeStart: 100, versionNodeEnd: 104, latest: "1.30.0" });

    const edits = await buildBazelVersionEdits([c1, c2]);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe(file);
    expect(edits[0].rewrites).toHaveLength(2);
  });

  it("rewrites in a single file have correct individual offset/length values", async () => {
    const file = "/repo/MODULE.bazel";
    // c1: version node at 40..47, c2: version node at 100..105
    const c1 = makeBazelCandidate({ file, name: "serde", versionNodeStart: 40, versionNodeEnd: 47, latest: "1.2.3" });
    const c2 = makeBazelCandidate({ file, name: "tokio", versionNodeStart: 100, versionNodeEnd: 105, latest: "2.0.0" });

    const edits = await buildBazelVersionEdits([c1, c2]);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;

    // Find by replace value
    const r1 = rewrites.find((r) => r.replace === '"1.2.3"')!;
    const r2 = rewrites.find((r) => r.replace === '"2.0.0"')!;

    expect(r1.offset).toBe(39);
    expect(r1.length).toBe(9);  // versionNodeEnd(47) - versionNodeStart(40) + 2 = 9
    expect(r2.offset).toBe(99);
    expect(r2.length).toBe(7);  // versionNodeEnd(105) - versionNodeStart(100) + 2 = 7
  });

  it("multiple files: produces one FileEdit per file", async () => {
    const c1 = makeBazelCandidate({ file: "/repo/MODULE.bazel", name: "serde", versionNodeStart: 40, versionNodeEnd: 47 });
    const c2 = makeBazelCandidate({ file: "/repo/other/MODULE.bazel", name: "tokio", versionNodeStart: 10, versionNodeEnd: 16 });

    const edits = await buildBazelVersionEdits([c1, c2]);
    expect(edits).toHaveLength(2);
    const files = edits.map((e) => e.file).sort();
    expect(files[0]).toBe("/repo/MODULE.bazel");
    expect(files[1]).toBe("/repo/other/MODULE.bazel");
  });

  it("rewrites for same file are structured for reverse-order application (offset-based)", async () => {
    // The implementation groups by file; reverse-sort happens in applyFileEdit.
    // Here we verify both offsets are present and distinct.
    const file = "/repo/MODULE.bazel";
    const c1 = makeBazelCandidate({ file, name: "serde", versionNodeStart: 40, versionNodeEnd: 47 });
    const c2 = makeBazelCandidate({ file, name: "tokio", versionNodeStart: 100, versionNodeEnd: 105 });

    const edits = await buildBazelVersionEdits([c1, c2]);
    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    const offsets = rewrites.map((r) => r.offset);

    // Both offsets present (39 and 99)
    expect(offsets).toContain(39);
    expect(offsets).toContain(99);
  });
});

// ─── Java buildFileEdits ─────────────────────────────────────────────────────

describe("java buildFileEdits", () => {
  it("produces string-based rewrite with bare coordinate search and updated version in replace", async () => {
    const candidate = makeJavaCandidate({
      artifactRaw: "com.google.guava:guava:31.1-jre",
      name: "com.google.guava:guava",
      current: "31.1-jre",
      latest: "32.0.0-jre",
    });

    const edits = await buildJavaEdits([candidate], "preserve");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(1);

    const rewrite = edits[0].rewrites[0] as { search: string; replace: string };
    // search: old full coordinate, no outer quotes
    expect(rewrite.search).toBe("com.google.guava:guava:31.1-jre");
    // replace: same coordinate with updated version
    expect(rewrite.replace).toBe("com.google.guava:guava:32.0.0-jre");
  });

  it("preserves classifier segments beyond version in coordinate", async () => {
    const candidate = makeJavaCandidate({
      artifactRaw: "org.example:mylib:1.0.0:sources",
      name: "org.example:mylib",
      current: "1.0.0",
      latest: "2.0.0",
    });

    const edits = await buildJavaEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { search: string; replace: string };
    expect(rewrite.search).toBe("org.example:mylib:1.0.0:sources");
    expect(rewrite.replace).toBe("org.example:mylib:2.0.0:sources");
  });

  it("multiple artifacts in same file: single FileEdit with multiple string rewrites", async () => {
    const file = "/repo/MODULE.bazel";
    const c1 = makeJavaCandidate({
      file,
      artifactRaw: "com.google.guava:guava:31.1-jre",
      name: "com.google.guava:guava",
      current: "31.1-jre",
      latest: "32.0.0-jre",
    });
    const c2 = makeJavaCandidate({
      file,
      artifactRaw: "org.slf4j:slf4j-api:1.7.36",
      name: "org.slf4j:slf4j-api",
      current: "1.7.36",
      latest: "2.0.0",
    });

    const edits = await buildJavaEdits([c1, c2], "preserve");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(2);
  });

  it("artifacts from different files: returns multiple FileEdits", async () => {
    const c1 = makeJavaCandidate({
      file: "/repo/MODULE.bazel",
      artifactRaw: "com.google.guava:guava:31.1-jre",
      name: "com.google.guava:guava",
      current: "31.1-jre",
      latest: "32.0.0-jre",
    });
    const c2 = makeJavaCandidate({
      file: "/repo/third_party/MODULE.bazel",
      artifactRaw: "org.slf4j:slf4j-api:1.7.36",
      name: "org.slf4j:slf4j-api",
      current: "1.7.36",
      latest: "2.0.0",
    });

    const edits = await buildJavaEdits([c1, c2], "preserve");
    expect(edits).toHaveLength(2);
  });

  it("skips inline-literal candidate whose latest version contains ':' (malformed registry response)", async () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const candidate = makeJavaCandidate({
      artifactRaw: "com.google.guava:guava:31.1-jre",
      name: "com.google.guava:guava",
      current: "31.1-jre",
      latest: "32.0.0-jre:junk",
    });

    const edits = await buildJavaEdits([candidate], "preserve");
    expect(edits).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("com.google.guava:guava"));
  });

  it("style parameter is ignored (semver-only ecosystem)", async () => {
    const candidate = makeJavaCandidate({
      artifactRaw: "com.google.guava:guava:31.1-jre",
      name: "com.google.guava:guava",
      current: "31.1-jre",
      latest: "32.0.0-jre",
    });

    const shaEdits = await buildJavaEdits([candidate], "sha");
    const preserveEdits = await buildJavaEdits([candidate], "preserve");

    // Both styles produce identical results
    expect(shaEdits[0].rewrites).toEqual(preserveEdits[0].rewrites);
  });

  // The versionRef path routes through bazel-shared.ts's pure string-slicing
  // computeNewConstantValue, but "numeric-looking" targets like "4.10" are exactly the
  // shape that a naive parseFloat/Number coercion would truncate to "4.1". Writes against
  // a real file on disk (not offset arithmetic alone) to prove the literal survives intact.
  it("numeric-looking version (4.10) through the versionRef path writes the literal, not coerce-normalized 4.1", async () => {
    const content = 'VERSION = "4.0"\n';
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lisan-java-"));
    const file = path.join(tmpDir, "MODULE.bazel");
    await fs.writeFile(file, content, "utf8");

    try {
      const versionRef: VersionRef = {
        value: "4.0",
        nodeStart: content.indexOf("4.0"),
        nodeEnd: content.indexOf("4.0") + "4.0".length,
        templatePrefix: "",
        templateSuffix: "",
      };
      const position: JavaArtifactPosition = { file, versionRef };
      const dep: DepRef = {
        ecosystem: "java",
        name: "com.example:foo",
        file,
        current: "4.0",
        position,
      };
      const candidate: UpdateCandidate = {
        dep,
        latest: "4.10",
        updateLevel: "minor",
        publishDate: null,
        ageDays: null,
        breaking: false,
      };

      const edits = await buildJavaEdits([candidate], "sha");
      expect(edits).toHaveLength(1);

      const { content: written } = await buildFileContent(edits[0]);
      expect(written).toBe('VERSION = "4.10"\n');
      expect(written).not.toContain('"4.1"');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── classifyUpdateLevel with coerced non-semver tags ───────────────────────

describe("classifyUpdateLevel — coerced non-semver", () => {
  it("two-part container tags: 1.20 → 1.21 is minor (not major)", () => {
    expect(classifyUpdateLevel("1.20", "1.21")).toBe("minor");
  });

  it("two-part container tags: 1.20 → 2.0 is major", () => {
    expect(classifyUpdateLevel("1.20", "2.0")).toBe("major");
  });

  it("two-part container tags: 1.20 → 1.20.1 coerces and detects patch", () => {
    // "1.20" coerces to "1.20.0"; "1.20.1" is strict semver → patch
    expect(classifyUpdateLevel("1.20", "1.20.1")).toBe("patch");
  });

  it("v-prefix action tags: v3 → v4 is major", () => {
    expect(classifyUpdateLevel("v3", "v4")).toBe("major");
  });

  it("v-prefix action tags: v3 → v3.1 is minor", () => {
    expect(classifyUpdateLevel("v3", "v3.1")).toBe("minor");
  });

  it("fully non-coercible tags: still returns major", () => {
    expect(classifyUpdateLevel("abc", "xyz")).toBe("major");
  });
});

// ─── Actions buildFileEdits — quote preservation ─────────────────────────────

describe("actions buildFileEdits — quote preservation", () => {
  it("preserve style: double-quoted value keeps double quotes in replacement", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      matchOffset: 0,
      matchLength: 22, // length of 'uses: "owner/repo@v3"'
      trailingComment: null,
      quoteChar: '"',
    });

    const edits = buildActionEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('uses: "owner/repo@v4"');
  });

  it("preserve style: single-quoted value keeps single quotes", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      matchOffset: 0,
      matchLength: 22,
      trailingComment: null,
      quoteChar: "'",
    });

    const edits = buildActionEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("uses: 'owner/repo@v4'");
  });

  it("sha style: preserves the original quote char around the SHA pin", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: "abc123",
      matchOffset: 0,
      matchLength: 22,
      quoteChar: '"',
    });

    const edits = buildActionEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('uses: "owner/repo@abc123"  # v4');
  });

  it("sha style: preserves a non-version trailing comment instead of overwriting it", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      pinnedTo: "abc123",
      matchOffset: 0,
      matchLength: 20,
      quoteChar: null,
      trailingComment: "# pin for security audit",
    });

    const edits = buildActionEdits([candidate], "sha");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("uses: owner/repo@abc123  # pin for security audit");
  });

  it("unquoted value remains unquoted", () => {
    const candidate = makeActionCandidate({
      name: "owner/repo",
      current: "v3",
      latest: "v4",
      matchOffset: 0,
      matchLength: 20,
      quoteChar: null,
    });

    const edits = buildActionEdits([candidate], "preserve");
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe("uses: owner/repo@v4");
  });
});

// ─── Duplicate-ref handling ──────────────────────────────────────────────────

describe("actions buildFileEdits — duplicate refs in same file", () => {
  it("same action at two different offsets produces two separate rewrites", () => {
    // Simulates a workflow that uses actions/checkout@v3 in two separate jobs
    const file = "/repo/.github/workflows/ci.yml";
    const c1 = makeActionCandidate({
      file,
      name: "actions/checkout",
      current: "v3",
      latest: "v4",
      pinnedTo: "sha1abc",
      matchOffset: 20,
      matchLength: 34,  // "uses: actions/checkout@v3"
      trailingCommentLength: 0,
    });
    const c2 = makeActionCandidate({
      file,
      name: "actions/checkout",
      current: "v3",
      latest: "v4",
      pinnedTo: "sha1abc",
      matchOffset: 200,  // second occurrence, different offset
      matchLength: 34,
      trailingCommentLength: 0,
    });

    const edits = buildActionEdits([c1, c2], "sha");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(2);

    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    const offsets = rewrites.map((r) => r.offset).sort((a, b) => a - b);
    expect(offsets[0]).toBe(20);
    expect(offsets[1]).toBe(200);
    // Both occurrences get the same replacement
    expect(rewrites.every((r) => r.replace === "uses: actions/checkout@sha1abc  # v4")).toBe(true);
  });
});

describe("docker buildFileEdits — duplicate refs in same file", () => {
  it("same image ref at two different offsets produces two separate rewrites", () => {
    // Simulates a multi-stage Dockerfile with FROM golang:1.21 twice
    const file = "/repo/Dockerfile";
    const c1 = makeDockerCandidate({
      file,
      raw: "golang:1.21",
      absoluteOffset: 5,
      refLength: 11,
      source: "from",
      name: "golang",
      current: "1.21",
      latest: "1.22",
      pinnedTo: "sha256:golangdigest",
    });
    const c2 = makeDockerCandidate({
      file,
      raw: "golang:1.21",
      absoluteOffset: 150,  // second stage, different offset
      refLength: 11,
      source: "from",
      name: "golang",
      current: "1.21",
      latest: "1.22",
      pinnedTo: "sha256:golangdigest",
    });

    const edits = buildDockerEdits([c1, c2], "sha");
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(2);

    const rewrites = edits[0].rewrites as Array<{ offset: number; length: number; replace: string }>;
    const offsets = rewrites.map((r) => r.offset).sort((a, b) => a - b);
    expect(offsets[0]).toBe(5);
    expect(offsets[1]).toBe(150);
    expect(rewrites.every((r) => r.replace === "golang:1.22@sha256:golangdigest  # was golang:1.21")).toBe(true);
  });
});

// ─── Constant-interpolation in buildBazelVersionEdits ────────────────────────

function makeConstBazelCandidate(opts: {
  file?: string;
  name?: string;
  current?: string;
  latest: string;
  versionRef: VersionRef;
  versionPrefix?: string;
  ecosystem?: "rust" | "bazel";
}): UpdateCandidate {
  const file = opts.file ?? "/repo/MODULE.bazel";
  const position: BazelVersionPosition = { versionRef: opts.versionRef, file, versionPrefix: opts.versionPrefix };
  const dep: DepRef = { ecosystem: opts.ecosystem ?? "rust", name: opts.name ?? "serde", file, current: opts.current ?? "1.0.150", position };
  return { dep, latest: opts.latest, updateLevel: "patch", publishDate: null, ageDays: null, breaking: false };
}

describe("buildBazelVersionEdits — constant interpolation", () => {
  it("templatePrefix: strips prefix from latest before writing to constant", async () => {
    // PROTOBUF_VERSION = "32.1" used as "...:4.%s" % PROTOBUF_VERSION → effective "4.32.1"
    // New version "4.33.0" → constant should become "33.0"
    const vr: VersionRef = {
      value: "4.32.1",
      nodeStart: 20,   // inside quotes of "32.1" in file
      nodeEnd: 24,
      templatePrefix: "4.",
      templateSuffix: "",
      constantName: "PROTOBUF_VERSION",
    };
    const candidate = makeConstBazelCandidate({ latest: "4.33.0", versionRef: vr });
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    // Constant value = "33.0" (stripped "4." prefix from "4.33.0")
    expect(rewrite.replace).toBe('"33.0"');
    expect(rewrite.offset).toBe(19); // nodeStart - 1
    expect(rewrite.length).toBe(6);  // nodeEnd - nodeStart + 2 = 24-20+2
  });

  it("incompatible templatePrefix: skips candidate with warning", async () => {
    const vr: VersionRef = {
      value: "4.32.1",
      nodeStart: 20,
      nodeEnd: 24,
      templatePrefix: "4.",
      templateSuffix: "",
      constantName: "PROTOBUF_VERSION",
    };
    // New version "5.0.0" doesn't start with "4." → skip
    const candidate = makeConstBazelCandidate({ latest: "5.0.0", versionRef: vr });
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(0);
  });

  it("shared constant — same replacement: reconciled to one rewrite", async () => {
    const vr: VersionRef = {
      value: "2.19.1",
      nodeStart: 20,
      nodeEnd: 26,
      templatePrefix: "",
      templateSuffix: "",
      constantName: "JACKSON_VERSION",
    };
    const file = "/repo/MODULE.bazel";
    const c1 = makeConstBazelCandidate({ file, name: "jackson-core", latest: "2.20.0", versionRef: vr });
    const c2 = makeConstBazelCandidate({ file, name: "jackson-databind", latest: "2.20.0", versionRef: vr });

    const edits = await buildBazelVersionEdits([c1, c2]);
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(1); // deduplicated
    const rewrite = edits[0].rewrites[0] as { offset: number; length: number; replace: string };
    expect(rewrite.replace).toBe('"2.20.0"');
  });

  it("shared constant — conflicting semver replacements: picks minimum", async () => {
    const vr: VersionRef = {
      value: "2.19.1",
      nodeStart: 20,
      nodeEnd: 26,
      templatePrefix: "",
      templateSuffix: "",
      constantName: "SHARED_VERSION",
    };
    const file = "/repo/MODULE.bazel";
    const c1 = makeConstBazelCandidate({ file, name: "libA", latest: "3.0.0", versionRef: vr });
    const c2 = makeConstBazelCandidate({ file, name: "libB", latest: "2.20.0", versionRef: vr });

    const edits = await buildBazelVersionEdits([c1, c2]);
    // Picks 2.20.0 (the minimum) — safe for both libA (which accepts ≥2.20.0) and libB
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };
    expect(rewrite.replace).toBe('"2.20.0"');
  });
});

// ─── Read-only versionRef (rpartition and similar lossy transforms) ───────────

describe("buildConstantRewrite — readOnly versionRef is never written", () => {
  it("returns null and emits a warning when versionRef.readOnly is true", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    // Simulates a versionRef produced by CONST.rpartition(".")[0] — the truncated
    // head cannot be inverted back to a full version for write-back.
    const vr: VersionRef = {
      value: "1.2",            // truncated head (original const = "1.2.3")
      nodeStart: 10,
      nodeEnd: 15,             // bracket the const literal "1.2.3"
      templatePrefix: "",
      templateSuffix: "",
      constantName: "VERSION",
      readOnly: true,
    };
    const candidate = makeConstBazelCandidate({ latest: "1.4.0", versionRef: vr });
    const result = buildConstantRewrite(candidate, vr, undefined, "/repo/MODULE.bazel");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("read-only"));
  });
});

describe("buildBazelVersionEdits — read-only rpartition ref alongside writable sibling", () => {
  it("emits a rewrite for the writable sibling only; skips the read-only rpartition ref", async () => {
    // Scenario: VERSION = "1.2.3"
    //   crate A: version = VERSION          → writable (nodeStart:10, nodeEnd:15)
    //   crate B: version = VERSION.rpartition(".")[0]  → readOnly (same const, nodeStart:10, nodeEnd:15)
    const sharedConstOffsets = { nodeStart: 10, nodeEnd: 15 };

    const writableVr: VersionRef = {
      value: "1.2.3",
      ...sharedConstOffsets,
      templatePrefix: "",
      templateSuffix: "",
      constantName: "VERSION",
    };
    const readOnlyVr: VersionRef = {
      value: "1.2",
      ...sharedConstOffsets,
      templatePrefix: "",
      templateSuffix: "",
      constantName: "VERSION",
      readOnly: true,
    };

    const file = "/repo/MODULE.bazel";
    const writableCandidate = makeConstBazelCandidate({ file, name: "crate-a", latest: "1.4.0", versionRef: writableVr });
    // The readOnly candidate would be filtered out by discover, but even if it reaches
    // buildBazelVersionEdits the defense-in-depth guard must drop it silently.
    const readOnlyCandidate = makeConstBazelCandidate({ file, name: "crate-b", latest: "1.4.0", versionRef: readOnlyVr });

    const edits = await buildBazelVersionEdits([writableCandidate, readOnlyCandidate]);
    expect(edits).toHaveLength(1);
    expect(edits[0].rewrites).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };
    expect(rewrite.replace).toBe('"1.4.0"');
  });
});

describe("reconcileConstantRewrites", () => {
  it("identical offset+length with same replace: emits one rewrite", () => {
    const rewrites = [
      { offset: 10, length: 5, replace: '"1.2.3"', expected: '"old"' },
      { offset: 10, length: 5, replace: '"1.2.3"', expected: '"old"' },
    ];
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(1);
    expect((result[0] as { replace: string }).replace).toBe('"1.2.3"');
  });

  it("identical offset+length with different semver replaces: picks minimum", () => {
    const rewrites = [
      { offset: 10, length: 5, replace: '"2.0.0"', expected: '"old"' },
      { offset: 10, length: 5, replace: '"1.2.3"', expected: '"old"' },
    ];
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(1);
    expect((result[0] as { replace: string }).replace).toBe('"1.2.3"');
  });

  it("identical offset+length with Cargo specifier prefix: drops group when all-exact-pin versions differ (L1)", () => {
    // L1 fix: all-exact-pin (=) specifiers with different inner versions → drop the group
    // (can't safely pick a minimum that satisfies both = constraints).
    const rewrites = [
      { offset: 10, length: 7, replace: '"=2.0.0"', expected: '"=old"' },
      { offset: 10, length: 7, replace: '"=1.5.0"', expected: '"=old"' },
    ];
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(0);
  });

  it("identical offset+length with 2-segment versions: picks minimum via semver.coerce", () => {
    // Before M2 fix: semver.valid("33.0") returned null, causing the group to be dropped.
    // After fix: semver.coerce("33.0") → 33.0.0, so the minimum is selected correctly.
    const rewrites = [
      { offset: 10, length: 6, replace: '"33.0"', expected: '"old1"' },
      { offset: 10, length: 6, replace: '"34.1"', expected: '"old1"' },
    ];
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(1);
    expect((result[0] as { replace: string }).replace).toBe('"33.0"');
    warnSpy.mockRestore();
  });

  it("identical offset+length with truly non-coercible replaces: drops all", () => {
    // Values like "build-foo" cannot be coerced to a semver at all — group must be dropped.
    const rewrites = [
      { offset: 10, length: 11, replace: '"build-foo"', expected: '"old-value"' },
      { offset: 10, length: 11, replace: '"build-bar"', expected: '"old-value"' },
    ];
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("different offsets: all pass through unchanged", () => {
    const rewrites = [
      { offset: 10, length: 5, replace: '"1.2.3"', expected: '"old"' },
      { offset: 50, length: 5, replace: '"4.5.6"', expected: '"old"' },
    ];
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(2);
  });

  it("string-based rewrites are passed through untouched", () => {
    const rewrites = [
      { search: "old:coord:1.0", replace: "old:coord:2.0" },
      { search: "other:coord:1.0", replace: "other:coord:2.0" },
    ];
    const { rewrites: result } = reconcileConstantRewrites(rewrites, "/repo/MODULE.bazel");
    expect(result).toHaveLength(2);
  });

  it("M5: mixed-template group is dropped with a warning when templateKeys are provided", () => {
    // Two rewrites target the same constant literal (same offset:length), but one was
    // computed from a bare dep (templateKey "bare" = ":") and the other from a template dep
    // (templateKey "prefix.:" or similar). Their replace values are in incompatible spaces:
    //   bare → replace = '"34.5"' (full version)
    //   template "1.%s" → replace = '"34.5"' happens to equal here, but conceptually differs.
    // Use explicitly different template keys to trigger the conflict path.
    const rwBare = { offset: 20, length: 7, replace: '"34.5"', expected: '"1.2.3"' };
    const rwTpl  = { offset: 20, length: 7, replace: '"4.5"',  expected: '"1.2.3"' };

    // Without templateKeys: replaces conflict → resolveConflictingReplaces picks semver-min.
    {
      const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
      const { rewrites: result } = reconcileConstantRewrites([rwBare, rwTpl], "/repo/MODULE.bazel");
      // "4.5" < "34.5" semver → pickSemverMin selects "4.5"
      expect(result).toHaveLength(1);
      expect((result[0] as { replace: string }).replace).toBe('"4.5"');
      warnSpy.mockRestore();
    }

    // With templateKeys carrying different template keys: group is dropped entirely.
    {
      const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
      const tplKeys = new Map<object, string>([
        [rwBare, ":"],           // bare: templatePrefix="" templateSuffix="" → key ":"
        [rwTpl,  "1.prefix:"],   // template: templatePrefix="1.prefix" templateSuffix="" → key "1.prefix:"
      ]);
      const { rewrites: result } = reconcileConstantRewrites([rwBare, rwTpl], "/repo/MODULE.bazel", tplKeys);
      expect(result).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicting template/bare references"));
      warnSpy.mockRestore();
    }
  });

  it("M5: same-template group is reconciled normally when templateKeys are provided", () => {
    // Two rewrites with identical template keys in the same group → no conflict drop.
    const rw1 = { offset: 10, length: 7, replace: '"1.2.4"', expected: '"1.2.3"' };
    const rw2 = { offset: 10, length: 7, replace: '"1.2.5"', expected: '"1.2.3"' };
    const tplKeys = new Map<object, string>([[rw1, ":"], [rw2, ":"]]);

    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const { rewrites: result } = reconcileConstantRewrites([rw1, rw2], "/repo/MODULE.bazel", tplKeys);
    // Same template → pickSemverMin("1.2.4","1.2.5") → "1.2.4"
    expect(result).toHaveLength(1);
    expect((result[0] as { replace: string }).replace).toBe('"1.2.4"');
    warnSpy.mockRestore();
  });
});

// ─── selectBazelDepRefs (bazel updater override filtering) ───────────────────

function makeVersionRef(value: string, nodeStart = 10, nodeEnd = 10 + value.length): VersionRef {
  return { value, nodeStart, nodeEnd, templatePrefix: "", templateSuffix: "" };
}

function makeBazelDep(name: string, version: string, nodeStart = 10): BazelDep {
  const versionRef = makeVersionRef(version, nodeStart, nodeStart + version.length);
  return { name, version, versionNodeStart: versionRef.nodeStart, versionNodeEnd: versionRef.nodeEnd, versionRef };
}

function makeOverride(type: BazelOverride["type"], moduleName: string, extra?: Partial<BazelOverride>): BazelOverride {
  return { type, moduleName, ...extra };
}

describe("selectBazelDepRefs", () => {
  it("emits a DepRef for a plain bazel_dep with no override", () => {
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("rules_go", "0.46.0")], overrides: new Map() },
    ];
    const refs = selectBazelDepRefs(parsed);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("rules_go");
    expect(refs[0].current).toBe("0.46.0");
    expect(refs[0].file).toBe("MODULE.bazel");
  });

  it("skips bazel_dep governed by local_path_override", () => {
    const overrides = new Map([["my_mod", makeOverride("local_path", "my_mod")]]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("my_mod", "1.0.0")], overrides },
    ];
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("skips bazel_dep governed by git_override", () => {
    const overrides = new Map([["my_mod", makeOverride("git", "my_mod", { remote: "https://github.com/example/my_mod" })]]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("my_mod", "1.0.0")], overrides },
    ];
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("skips bazel_dep governed by archive_override", () => {
    const overrides = new Map([["my_mod", makeOverride("archive", "my_mod", { urls: ["https://example.com/archive.tar.gz"] })]]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("my_mod", "1.0.0")], overrides },
    ];
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("skips bazel_dep governed by multiple_version_override", () => {
    const overrides = new Map([["my_mod", makeOverride("multiple_version", "my_mod", { versions: ["1.0.0", "2.0.0"] })]]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("my_mod", "1.0.0")], overrides },
    ];
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("redirects single_version_override with version= to the override literal", () => {
    const overrideVersionRef = makeVersionRef("0.0.9", 200);
    const overrides = new Map([
      ["rules_cc", makeOverride("single_version", "rules_cc", { version: "0.0.9", versionRef: overrideVersionRef })],
    ]);
    const parsed = [
      {
        file: "MODULE.bazel",
        bazelDeps: [makeBazelDep("rules_cc", "0.0.8")],
        overrides,
      },
    ];
    const refs = selectBazelDepRefs(parsed);
    // The bazel_dep at version 0.0.8 must be skipped; the override at 0.0.9 must be emitted.
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("rules_cc");
    expect(refs[0].current).toBe("0.0.9");
    // position must point at the override's version literal, not the bazel_dep literal
    expect((refs[0].position as { versionRef: VersionRef }).versionRef.nodeStart).toBe(200);
  });

  it("emits bazel_dep for single_version_override without version= (registry-only pin)", () => {
    // single_version_override(module_name = "my_mod", registry = "https://custom-registry.example.com")
    // No version= → bazel_dep version is still the operative version.
    const overrides = new Map([
      ["my_mod", makeOverride("single_version", "my_mod", { registry: "https://custom-registry.example.com" })],
    ]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("my_mod", "1.2.3")], overrides },
    ];
    const refs = selectBazelDepRefs(parsed);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("my_mod");
    expect(refs[0].current).toBe("1.2.3");
  });

  it("applies override from a different file than the bazel_dep", () => {
    // Override in third_party/MODULE.bazel governs a bazel_dep in MODULE.bazel
    const overrideVersionRef = makeVersionRef("2.0.0", 50);
    const overrides = new Map([
      ["dep_a", makeOverride("single_version", "dep_a", { version: "2.0.0", versionRef: overrideVersionRef })],
    ]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("dep_a", "1.0.0")], overrides: new Map() },
      { file: "third_party/MODULE.bazel", bazelDeps: [], overrides },
    ];
    const refs = selectBazelDepRefs(parsed);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("dep_a");
    expect(refs[0].current).toBe("2.0.0");
    expect(refs[0].file).toBe("third_party/MODULE.bazel");
  });

  it("emits unrelated deps alongside skipped overridden ones", () => {
    const overrides = new Map([["overridden", makeOverride("git", "overridden")]]);
    const parsed = [
      {
        file: "MODULE.bazel",
        bazelDeps: [makeBazelDep("overridden", "1.0.0", 10), makeBazelDep("normal_dep", "3.0.0", 100)],
        overrides,
      },
    ];
    const refs = selectBazelDepRefs(parsed);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("normal_dep");
  });

  it("skips bazel_dep whose versionRef is read-only (e.g. CONST.rpartition('.')[0])", () => {
    // The dep is still tracked in directDepNames so that a writable single_version_override
    // could drive an update, but the dep itself must not be proposed for rewrite.
    const readOnlyDep: BazelDep = {
      name: "rules_foo",
      version: "1.2",
      versionRef: { ...makeVersionRef("1.2"), readOnly: true },
    };
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [readOnlyDep], overrides: new Map() },
    ];
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("skips single_version_override whose own versionRef is read-only", () => {
    const readOnlyOverrideVr: VersionRef = { ...makeVersionRef("1.2", 200), readOnly: true };
    const overrides = new Map([
      ["rules_foo", makeOverride("single_version", "rules_foo", { version: "1.2", versionRef: readOnlyOverrideVr })],
    ]);
    const parsed = [
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("rules_foo", "1.2.3")], overrides },
    ];
    // bazel_dep redirects to override, but override versionRef is read-only → no DepRef emitted
    expect(selectBazelDepRefs(parsed)).toHaveLength(0);
  });

  it("does not emit redirect for single_version_override on a purely transitive dep (no bazel_dep in any file)", () => {
    // Bazel allows single_version_override on transitive deps. The updater must not
    // propose bumping them — the user never declared the dep directly.
    const overrideVersionRef = makeVersionRef("20240722.0", 50);
    const overrides = new Map([
      ["abseil-cpp", makeOverride("single_version", "abseil-cpp", { version: "20240722.0", versionRef: overrideVersionRef })],
    ]);
    const parsed = [
      // No bazel_dep(name="abseil-cpp") anywhere — only the override
      { file: "MODULE.bazel", bazelDeps: [makeBazelDep("rules_go", "0.46.0")], overrides },
    ];
    const refs = selectBazelDepRefs(parsed);
    // rules_go has no override → emitted; abseil-cpp has no bazel_dep → no redirect
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("rules_go");
  });
});

// ─── buildConstantRewrite ────────────────────────────────────────────────────

describe("buildConstantRewrite", () => {
  function makeCandidate(latest: string): UpdateCandidate {
    return {
      dep: { ecosystem: "rust", name: "mycrate", file: "MODULE.bazel", current: "1.0.0", position: {} },
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-01-01"),
      ageDays: 200,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("returns a valid rewrite for a direct literal version", () => {
    const vref: VersionRef = {
      value: "1.0.0", nodeStart: 11, nodeEnd: 16,
      templatePrefix: "", templateSuffix: "",
    };
    const rw = buildConstantRewrite(makeCandidate("2.0.0"), vref, undefined, "MODULE.bazel");
    expect(rw).not.toBeNull();
    expect(rw!.replace).toBe('"2.0.0"');
    expect(rw!.expected).toBe('"1.0.0"');
    expect(rw!.offset).toBe(10);   // nodeStart - 1
    expect(rw!.length).toBe(7);    // nodeEnd - nodeStart + 2
  });

  it("returns null and warns when latest is incompatible with templatePrefix", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const vref: VersionRef = {
      value: "33.0",   // full value = prefix + literal + suffix = "4." + "33.0" + ""
      nodeStart: 11, nodeEnd: 15,
      templatePrefix: "4.", templateSuffix: "",
    };
    // latest "5.0.1" does NOT start with "4." → incompatible
    const rw = buildConstantRewrite(makeCandidate("5.0.1"), vref, undefined, "MODULE.bazel");
    expect(rw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("incompatible with template prefix"));
    warnSpy.mockRestore();
  });

  it("returns null and warns when oldLiteral cannot be computed (value incompatible with template)", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    // Simulate a vref whose value does not start with templatePrefix —
    // this would be an inconsistent VersionRef (shouldn't happen in normal flow,
    // but buildConstantRewrite must fail-closed rather than using the raw value).
    const vref: VersionRef = {
      value: "unexpected",  // does NOT start with "4." → computeNewConstantValue returns null
      nodeStart: 11, nodeEnd: 20,
      templatePrefix: "4.", templateSuffix: "",
    };
    // latest "4.33.0" starts with "4." so newConstValue = "33.0" — passes the first check.
    // But vref.value = "unexpected" doesn't start with "4." → oldLiteral is null → skip.
    const rw = buildConstantRewrite(makeCandidate("4.33.0"), vref, undefined, "MODULE.bazel");
    expect(rw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot compute oldLiteral"));
    warnSpy.mockRestore();
  });

  it("returns null and warns when Cargo prefix is combined with interpolation template", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const vref: VersionRef = {
      value: "33.0", nodeStart: 11, nodeEnd: 15,
      templatePrefix: "4.", templateSuffix: "",
    };
    const rw = buildConstantRewrite(makeCandidate("4.33.0"), vref, "=", "MODULE.bazel");
    expect(rw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot combine"));
    warnSpy.mockRestore();
  });

  // B2: degenerate / fuzzed versionRef guards (per-candidate skip, not whole-file abort)
  it("B2: returns null and warns when nodeEnd < nodeStart (degenerate versionRef)", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const vref: VersionRef = {
      value: "1.0.0", nodeStart: 20, nodeEnd: 10, // nodeEnd < nodeStart — degenerate
      templatePrefix: "", templateSuffix: "",
    };
    const rw = buildConstantRewrite(makeCandidate("2.0.0"), vref, undefined, "MODULE.bazel");
    expect(rw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("degenerate versionRef offsets"));
    warnSpy.mockRestore();
  });

  it("B2: returns null and warns for triple-quoted string (quote.length !== 1)", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const vref: VersionRef = {
      value: "1.0.0", nodeStart: 11, nodeEnd: 16,
      templatePrefix: "", templateSuffix: "",
      quote: '"""', // triple-quoted — offset arithmetic would be wrong
    };
    const rw = buildConstantRewrite(makeCandidate("2.0.0"), vref, undefined, "MODULE.bazel");
    expect(rw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported quote style"));
    warnSpy.mockRestore();
  });

  it("B2: degenerate candidate skips only itself, valid sibling still produces a rewrite", () => {
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const goodVref: VersionRef = { value: "1.0.0", nodeStart: 11, nodeEnd: 16, templatePrefix: "", templateSuffix: "" };
    const badVref: VersionRef = { value: "1.0.0", nodeStart: 50, nodeEnd: 40, templatePrefix: "", templateSuffix: "" };
    const goodRw = buildConstantRewrite(makeCandidate("2.0.0"), goodVref, undefined, "MODULE.bazel");
    const badRw = buildConstantRewrite(makeCandidate("2.0.0"), badVref, undefined, "MODULE.bazel");
    expect(goodRw).not.toBeNull();
    expect(badRw).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("degenerate versionRef offsets"));
    warnSpy.mockRestore();
  });
});

// ─── pickSemverMin ────────────────────────────────────────────────────────────

describe("pickSemverMin", () => {
  it("returns the item with the lowest semver version", () => {
    const items = [
      { v: "2.1.0" },
      { v: "1.5.0" },
      { v: "2.0.0" },
    ];
    expect(pickSemverMin(items, (i) => i.v)).toEqual({ v: "1.5.0" });
  });

  it("handles 2-segment Maven-style versions", () => {
    const items = [{ v: "4.13" }, { v: "4.9" }, { v: "4.12" }];
    expect(pickSemverMin(items, (i) => i.v)).toEqual({ v: "4.9" });
  });

  it("returns null for an empty array", () => {
    expect(pickSemverMin([], (i: { v: string }) => i.v)).toBeNull();
  });

  it("returns null when no version can be coerced", () => {
    const items = [{ v: "not-a-version" }, { v: "also-not" }];
    expect(pickSemverMin(items, (i) => i.v)).toBeNull();
  });

  it("returns the single item when array has one element", () => {
    const items = [{ v: "3.0.0" }];
    expect(pickSemverMin(items, (i) => i.v)).toEqual({ v: "3.0.0" });
  });

  it("correctly handles a non-coercible seed followed by a coercible item", () => {
    // Exercises the !minCoerced branch: seed item fails coerce, later item succeeds.
    const items = [{ v: "not-a-version" }, { v: "2.0.0" }];
    expect(pickSemverMin(items, (i) => i.v)).toEqual({ v: "2.0.0" });
  });

  it("tie-break determinism: two items coercing to the same semver keep the first-seen item", () => {
    // "2.0" and "2.0.0" both resolve to semver "2.0.0". The comparison uses strict
    // `semver.lt`, which is false on a tie, so the later item never displaces the
    // earlier one — the result is deterministic (first-seen wins) rather than
    // depending on array iteration/sort implementation details.
    const items = [{ v: "2.0" }, { v: "2.0.0" }];
    expect(pickSemverMin(items, (i) => i.v)).toEqual({ v: "2.0" });

    const reversed = [{ v: "2.0.0" }, { v: "2.0" }];
    expect(pickSemverMin(reversed, (i) => i.v)).toEqual({ v: "2.0.0" });
  });
});

// ─── H2 cross-check: rewriteKeyOf must agree with buildFileEdits ─────────────
//
// For each ecosystem, assert that the "offset:length" key produced by the
// per-ecosystem `rewriteKeyOf` exactly matches the key from the first
// OffsetRewrite emitted by `buildFileEdits`. If any `buildFileEdits` formula
// changes without updating `rewriteKeyOf`, these tests catch the drift before it
// silently routes successfully-applied candidates to `noEdits` in `attributeRewrites`.

describe("rewriteKeyOf cross-check vs buildFileEdits", () => {
  it("actions: rewriteKeyOf matches offset:length of the rewrite produced by buildFileEdits", () => {
    const candidate = makeActionCandidate({
      matchOffset: 100,
      matchLength: 22,          // length of "uses: owner/repo@v3" + padding
      trailingCommentLength: 8, // length of "  # v3.0"
      trailingComment: "# v3.0",
      // originalSpan must be exactly matchLength+trailingCommentLength chars for the
      // stale-offset guard, but for this cross-check we only verify offset:length.
      current: "v3",
      latest: "v4",
      pinnedTo: "abc123defabc123defabc123def456ab",  // 32-char fake SHA
    });
    // The rewrite produced by buildFileEdits
    const edits = buildActionEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    const keyFromBuild = `${rw.offset}:${rw.length}`;
    // The key from rewriteKeyOf — must agree
    expect(actionsRewriteKeyOf(candidate)).toBe(keyFromBuild);
  });

  it("docker FROM: rewriteKeyOf matches offset:length of the rewrite produced by buildFileEdits", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 50,
      refLength: 10,          // length of "nginx:1.20"
      trailingConsumeLength: 15, // " AS web  # was ..." span
      expected: "nginx:1.20  # was old",
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });
    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    const keyFromBuild = `${rw.offset}:${rw.length}`;
    expect(dockerRewriteKeyOf(candidate)).toBe(keyFromBuild);
  });

  it("docker copy-from: rewriteKeyOf matches offset:length (trailingConsumeLength=0)", () => {
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 70,
      refLength: 10,
      trailingConsumeLength: 0,
      source: "copy-from",
      latest: "1.21",
      pinnedTo: "sha256:def456",
    });
    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    expect(dockerRewriteKeyOf(candidate)).toBe(`${rw.offset}:${rw.length}`);
  });

  it("kubernetes: rewriteKeyOf matches offset:length of the rewrite produced by buildFileEdits", () => {
    const candidate = makeK8sCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 80,
      refLength: 10,
      latest: "1.21",
      pinnedTo: "sha256:ghi789",
    });
    const edits = buildK8sEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    expect(k8sRewriteKeyOf(candidate)).toBe(`${rw.offset}:${rw.length}`);
  });

  it("bazel/rust versionRef: rewriteKeyOf matches offset:length of the rewrite produced by buildBazelVersionEdits", async () => {
    // nodeStart=201, nodeEnd=208 → "1.0.150" is 7 chars inside quotes
    // offset = nodeStart-1 = 200, length = nodeEnd-nodeStart+2 = 9
    const candidate = makeBazelCandidate({
      versionNodeStart: 201,
      versionNodeEnd: 208,
      current: "1.0.150",
      latest: "1.0.200",
      ecosystem: "rust",
    });
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    expect(bazelRewriteKeyOf(candidate)).toBe(`${rw.offset}:${rw.length}`);
  });

  it("java versionRef: rewriteKeyOf returns same key as bazelRewriteKeyOf (shared formula)", async () => {
    // Java versionRef candidates use the same formula as bazel-shared.
    const vr: VersionRef = {
      value: "31.1-jre",
      nodeStart: 301,
      nodeEnd: 309,         // 8-char value "31.1-jre"
      templatePrefix: "",
      templateSuffix: "",
    };
    const file = "/repo/MODULE.bazel";
    const position: JavaArtifactPosition = { file, versionRef: vr };
    const dep: DepRef = {
      ecosystem: "java",
      name: "com.google.guava:guava",
      file,
      current: "31.1-jre",
      position,
    };
    const candidate: UpdateCandidate = {
      dep,
      latest: "32.0.0-jre",
      updateLevel: "major",
      publishDate: null,
      ageDays: null,
      breaking: true,
    };
    const edits = await buildJavaEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rw = edits[0].rewrites[0] as { offset: number; length: number };
    expect(javaRewriteKeyOf(candidate)).toBe(`${rw.offset}:${rw.length}`);
    // Also assert formula: offset=300, length=10
    expect(javaRewriteKeyOf(candidate)).toBe("300:10");
  });

  it("java artifactRaw: rewriteKeyOf returns undefined (string-based rewrite has no offset key)", () => {
    const candidate = makeJavaCandidate({
      artifactRaw: "com.google.guava:guava:31.1-jre",
      latest: "32.0.0-jre",
    });
    expect(javaRewriteKeyOf(candidate)).toBeUndefined();
  });
});

// ─── H4: docker discover() annotation detection round-trip ───────────────────
// Tests the annotation classification logic inside discover() that the
// buildFileEdits tests cannot reach (they receive pre-built DockerPosition
// objects). Key invariants:
// 1. A prior "# was <ref>" annotation is stripped; any trailing author comment
//    is preserved in existingTrailingComment, NOT re-emitted as an annotation.
// 2. The ternary at docker.ts:128 correctly prefixes bare-text remainders with
//    "# " so the emitted Dockerfile line remains valid.

describe("docker discover() annotation detection (H4)", () => {
  const DIGEST = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";

  afterEach(() => vi.restoreAllMocks());

  async function discoverContent(dockerfile: string): Promise<DockerPosition[]> {
    vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue(["/fake/Dockerfile"]);
    vi.spyOn(sharedUpdater, "readFilesSafe").mockResolvedValue([
      { file: "/fake/Dockerfile", content: dockerfile },
    ]);
    const deps = await discoverDocker({});
    return deps.map((d) => d.position as DockerPosition);
  }

  it("prior '# was <ref>  # author note' → author note preserved, annotation stripped", async () => {
    const dockerfile = `FROM nginx@${DIGEST}  # was nginx:1.24  # prod note\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# prod note");
  });

  it("prior '# was <ref> bare text' → bare text prefixed with '# ' (ternary fix)", async () => {
    // Exercises the branch where remainder does not start with '#'.
    // Before the fix: existingTrailingComment = "bare text" (no '#' → invalid Dockerfile).
    // After the fix:  existingTrailingComment = "# bare text" (safe for re-append).
    const dockerfile = `FROM nginx@${DIGEST}  # was nginx:1.24 bare text\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# bare text");
  });

  it("genuine author comment (no '# was' prefix) → entire comment preserved", async () => {
    const dockerfile = `FROM nginx@${DIGEST}  # production image — keep pinned\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# production image — keep pinned");
  });

  it("no trailing comment → existingTrailingComment is empty", async () => {
    const dockerfile = `FROM nginx@${DIGEST}\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("");
  });

  it("annotation token containing embedded '#' is treated as author comment (M-container-1 regression)", async () => {
    // The old `indexOf("#", 1)` approach split "registry/repo#tag:1.24" at the embedded "#",
    // fabricating a spurious "#tag:1.24" author comment. The current fix goes further: since
    // "registry/repo#tag" is not a valid OCI repository name (# is not allowed), parseImageRef
    // returns null and the entire comment is preserved verbatim as an author comment — more
    // correct than the prior "consume as annotation" behaviour (an invalid ref was never our
    // annotation in the first place).
    const dockerfile = `FROM nginx@${DIGEST}  # was registry/repo#tag:1.24\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# was registry/repo#tag:1.24");
  });

  // H1 regression: annotation gate must require ":" or "@" in the captured token.
  // Plain words like "experimental" and "here" must be preserved verbatim, not consumed.
  it("H1: '# was experimental' → plain-word token, preserved as author comment", async () => {
    const dockerfile = `FROM nginx@${DIGEST}  # was experimental\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    // The whole comment must be preserved — it is NOT a tool-injected annotation.
    expect(positions[0].existingTrailingComment).toBe("# was experimental");
  });

  it("H1: '# was here' → plain-word token, preserved as author comment", async () => {
    const dockerfile = `FROM nginx@${DIGEST}  # was here\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# was here");
  });

  // H1b regression: a "# was <repo>:<tag>" comment whose repository differs from the
  // current image's repository must be preserved verbatim, not consumed as an annotation.
  // Example: `FROM nginx:1.25  # was alpine:3 in staging` — token "alpine:3" contains ":"
  // but its repository ("alpine") ≠ the current image's repository ("nginx"), so it is a
  // genuine author note, not a tool-injected "# was" line.
  it("H1b: '# was alpine:3 in staging' on a nginx FROM → different repo → preserved as author comment", async () => {
    const dockerfile = `FROM nginx:1.25  # was alpine:3 in staging\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    // The whole comment must be preserved — the repo "alpine" ≠ "nginx" so this is not our annotation.
    expect(positions[0].existingTrailingComment).toBe("# was alpine:3 in staging");
  });

  it("H1b control: '# was nginx:1.24' on a nginx:1.25 FROM → same repo → consumed as annotation", async () => {
    // Positive case: when the annotation token has the SAME repository as the current image,
    // the comment IS a tool-injected annotation and must be stripped (replaced by the new one).
    const dockerfile = `FROM nginx:1.25  # was nginx:1.24\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    // The old annotation is consumed → existingTrailingComment is empty (no author remainder).
    expect(positions[0].existingTrailingComment).toBe("");
  });

  // N4 regression: a "# was <token>" whose repository segment matches but whose
  // registry host differs must NOT be treated as our own annotation — a tool
  // annotation always names the prior ref of the SAME image, so its registry can
  // never differ. Without this check, a same-named repository on a different
  // registry (e.g. a private mirror also called "nginx") would be misclassified.
  it("N4: '# was otherregistry.example.com/nginx:1.24' on a myregistry.example.com/nginx FROM → same repo, different registry → preserved as author comment", async () => {
    const dockerfile = `FROM myregistry.example.com/nginx:1.25  # was otherregistry.example.com/nginx:1.24\n`;
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    expect(positions[0].existingTrailingComment).toBe("# was otherregistry.example.com/nginx:1.24");
  });
});

// ─── docker "# was" replace-not-append: write-level round trip ──────────────
// The most intricate string surgery in the PR: re-running the updater against an
// already-annotated FROM line must produce exactly one "# was" comment (not a second
// one appended to the first) and must preserve any genuine author comment that follows
// it. This exercises the full discover() → buildFileEdits() → buildFileContent() path
// against a real file on disk, not just offset arithmetic.

describe("docker # was replace-not-append — write-level round trip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-updating an already-annotated FROM line writes exactly one # was and preserves the author comment", async () => {
    const oldDigest = `sha256:${"a".repeat(64)}`;
    const newDigest = `sha256:${"b".repeat(64)}`;
    const dockerfile = `FROM nginx@${oldDigest}  # was nginx:1.23  # prod\n`;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lisan-docker-"));
    const file = path.join(tmpDir, "Dockerfile");
    await fs.writeFile(file, dockerfile, "utf8");

    try {
      vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue([file]);

      const deps = await discoverDocker({});
      expect(deps).toHaveLength(1);

      const candidate: UpdateCandidate = {
        dep: deps[0],
        latest: "1.24",
        pinnedTo: newDigest,
        updateLevel: "minor",
        publishDate: null,
        ageDays: null,
        breaking: false,
      };

      const edits = buildDockerEdits([candidate], "sha");
      expect(edits).toHaveLength(1);

      const { content } = await buildFileContent(edits[0]);

      // Exactly one "# was" annotation — the prior one was consumed, not appended to.
      expect(content.match(/# was/g)).toHaveLength(1);
      // The new digest/tag is written and the old annotation's author-comment
      // remainder ("# prod") is preserved verbatim after the new "# was" note.
      expect(content).toBe(
        `FROM nginx:1.24@${newDigest}  # was nginx@${oldDigest}  # prod\n`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── docker discover() imageExists gate for copy-from / mount-from (P4) ──────
// Mirrors the verify-side gate in src/ecosystems/docker.ts:getChangedDeps — COPY
// --from and RUN --mount=from images must be positively confirmed in the registry
// before being treated as real external dependencies; FROM is never gated (it is
// an unambiguous real image reference).

describe("docker discover() imageExists gate (P4)", () => {
  afterEach(() => vi.restoreAllMocks());

  async function discoverContent(dockerfile: string, opts: { dockerhubMirror?: string } = {}) {
    vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue(["/fake/Dockerfile"]);
    vi.spyOn(sharedUpdater, "readFilesSafe").mockResolvedValue([
      { file: "/fake/Dockerfile", content: dockerfile },
    ]);
    return discoverDocker(opts);
  }

  it("COPY --from confirmed (found) in registry is included", async () => {
    const existsSpy = vi.spyOn(registry, "imageExists").mockResolvedValue("found");
    const dockerfile = "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /app /app\n";
    const deps = await discoverContent(dockerfile);
    expect(deps.map((d) => d.name)).toContain("myregistry.io/myimage");
    expect(existsSpy).toHaveBeenCalledWith("myregistry.io", "myimage", "v1", undefined);
  });

  it("COPY --from not found in registry is omitted", async () => {
    vi.spyOn(registry, "imageExists").mockResolvedValue("notfound");
    const dockerfile = "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /app /app\n";
    const deps = await discoverContent(dockerfile);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain("myregistry.io/myimage");
    expect(names).toContain("docker.io/library/alpine"); // FROM still present, not gated
  });

  it("COPY --from returning unknown (401/429/network error) is omitted", async () => {
    vi.spyOn(registry, "imageExists").mockResolvedValue("unknown");
    const dockerfile = "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /app /app\n";
    const deps = await discoverContent(dockerfile);
    expect(deps.map((d) => d.name)).not.toContain("myregistry.io/myimage");
  });

  it("RUN --mount=from confirmed (found) in registry is included", async () => {
    vi.spyOn(registry, "imageExists").mockResolvedValue("found");
    const dockerfile = "FROM alpine:3.18\nRUN --mount=type=cache,from=myregistry.io/cache:latest echo hi\n";
    const deps = await discoverContent(dockerfile);
    expect(deps.map((d) => d.name)).toContain("myregistry.io/cache");
  });

  it("FROM is never existence-gated, even when imageExists would return notfound", async () => {
    const existsSpy = vi.spyOn(registry, "imageExists").mockResolvedValue("notfound");
    const dockerfile = "FROM alpine:3.18\n";
    const deps = await discoverContent(dockerfile);
    expect(deps.map((d) => d.name)).toContain("docker.io/library/alpine");
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it("passes dockerhubMirror through to imageExists for copy-from refs", async () => {
    const existsSpy = vi.spyOn(registry, "imageExists").mockResolvedValue("found");
    const dockerfile = "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /app /app\n";
    await discoverContent(dockerfile, { dockerhubMirror: "mirror.gcr.io" });
    expect(existsSpy).toHaveBeenCalledWith("myregistry.io", "myimage", "v1", "mirror.gcr.io");
  });
});

// ─── A1: No-trailing-newline Dockerfile — no AS duplication ──────────────────
// A Dockerfile whose last FROM has no trailing newline causes dockerfile-ast to
// report instrEndLine === lines.length (one past the last line). The old fallback
// `lineStarts[instrEndLine] ?? lineStarts[lineStarts.length - 1] ?? 0` fell back
// to the LAST LINE START, making absoluteInstrEnd < absoluteOffset + refLength
// → trailingConsumeLength = 0 → the AS clause was not consumed → rewrite appended
// " AS stage" while the original clause was still present → duplicated stage name.
//
// After the fix: lineStarts[instrEndLine] ?? content.length gives the correct end.

describe("docker discover() A1 — no-trailing-newline Dockerfile", () => {
  afterEach(() => vi.restoreAllMocks());

  async function discoverContent(dockerfile: string): Promise<DockerPosition[]> {
    vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue(["/fake/Dockerfile"]);
    vi.spyOn(sharedUpdater, "readFilesSafe").mockResolvedValue([
      { file: "/fake/Dockerfile", content: dockerfile },
    ]);
    const deps = await discoverDocker({});
    return deps.map((d) => d.position as DockerPosition);
  }

  it("A1: FROM with AS stage and no trailing newline — trailingConsumeLength covers the AS clause", async () => {
    // No trailing `\n` after the FROM — dockerfile-ast reports instrEndLine === lines.length.
    // The AS clause " AS builder" must be fully consumed (trailingConsumeLength > 0).
    const dockerfile = "FROM nginx:1.20 AS builder";  // no trailing newline
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    // trailingConsumeLength must be > 0 (the AS clause is consumed, not duplicated).
    expect(positions[0].trailingConsumeLength).toBeGreaterThan(0);
    // restOfLine must contain the stage name.
    expect(positions[0].restOfLine).toBe(" AS builder");
    // The expected span must include the AS clause bytes.
    expect(positions[0].expected).toBe("nginx:1.20 AS builder");
  });

  it("A1: buildFileEdits does not duplicate AS stage for a no-newline Dockerfile", async () => {
    // Simulate the position that discover() would produce for a no-newline Dockerfile.
    // refLength = 10 ("nginx:1.20"), trailingConsumeLength = 11 (" AS builder").
    const asClause = " AS builder";
    const candidate = makeDockerCandidate({
      raw: "nginx:1.20",
      absoluteOffset: 5,
      refLength: 10,
      trailingConsumeLength: asClause.length,
      restOfLine: asClause,
      expected: "nginx:1.20 AS builder",
      source: "from",
      latest: "1.21",
      pinnedTo: "sha256:abc123",
    });

    const edits = buildDockerEdits([candidate], "sha");
    expect(edits).toHaveLength(1);
    const rewrite = edits[0].rewrites[0] as { replace: string };
    // AS clause appears exactly once (not duplicated).
    const asCount = (rewrite.replace.match(/\bAS builder\b/g) ?? []).length;
    expect(asCount).toBe(1);
    // Full expected structure.
    expect(rewrite.replace).toBe("nginx:1.21@sha256:abc123 AS builder  # was nginx:1.20");
  });
});

// ─── A3: Double-space before AS — # was annotation placed correctly ───────────

describe("docker discover() A3 — double-space before AS", () => {
  afterEach(() => vi.restoreAllMocks());

  async function discoverContent(dockerfile: string): Promise<DockerPosition[]> {
    vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue(["/fake/Dockerfile"]);
    vi.spyOn(sharedUpdater, "readFilesSafe").mockResolvedValue([
      { file: "/fake/Dockerfile", content: dockerfile },
    ]);
    const deps = await discoverDocker({});
    return deps.map((d) => d.position as DockerPosition);
  }

  it("A3: FROM with double-space before AS and trailing comment — comment placed correctly", async () => {
    // "FROM nginx:1.20  AS  build  # prod" — two spaces before/after AS.
    // Old code used restOfLine.length (" AS build" = 9 chars) as the # search start,
    // but the actual consumedSpan is "  AS  build  # prod" (double spaces) — offset 9
    // would land at "  # prod" (inside the stage name), mis-locating the comment.
    // A3 fix: regex-match AS in consumedSpan to find the true end before searching for #.
    const dockerfile = "FROM nginx:1.20  AS  build  # prod\n";
    const positions = await discoverContent(dockerfile);
    expect(positions).toHaveLength(1);
    // existingTrailingComment must be the trailing "# prod", not some mangled substring.
    expect(positions[0].existingTrailingComment).toBe("# prod");
    // restOfLine is the clean reconstructed AS clause (single space — from AST, not raw).
    expect(positions[0].restOfLine).toBe(" AS build");
  });
});

// ─── A2: getImageRange() returns null — image skipped with warning ────────────

describe("docker discover() A2 — getImageRange() null fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("A2: image is skipped with a warning when getImageRange() returns null", async () => {
    // Patch parseDockerfileImagesWithPositions to simulate the scenario where
    // dockerfile-ast's getImageRange() returns null: the item has lineOffset = 0
    // (instruction start character, i.e. "F" of "FROM") rather than pointing into
    // the image string "nginx:1.20" (which starts at character 5).
    // discover() detects the mismatch via content.slice(absoluteOffset, ...) !== item.raw
    // and emits a warning + skips the image.
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});

    const dockerfile = "FROM nginx:1.20\n";
    vi.spyOn(sharedUpdater, "discoverViaGlobs").mockResolvedValue(["/fake/Dockerfile"]);
    vi.spyOn(sharedUpdater, "readFilesSafe").mockResolvedValue([
      { file: "/fake/Dockerfile", content: dockerfile },
    ]);

    // Import the shared docker module to patch parseDockerfileImagesWithPositions.
    // We simulate the bad position that the null-fallback produces: lineOffset = 0
    // (instruction start) rather than 5 (where "nginx:1.20" actually begins).
    const dockerEcosystem = await import("../src/ecosystems/docker.js");
    const parseSpy = vi.spyOn(dockerEcosystem, "parseDockerfileImagesWithPositions")
      .mockReturnValue([{
        raw: "nginx:1.20",
        ref: { registry: "docker.io", repository: "library/nginx", tag: "1.20", digest: null },
        source: "from",
        lineIndex: 0,
        lineOffset: 0,   // wrong: instruction start, not image start (simulates null imgRange)
        lineLength: 10,  // length of "nginx:1.20"
        instrLineIndex: 0,
        buildStage: null,
        instrEndLine: 1,
        instrEndChar: 0,
      }]);

    const deps = await discoverDocker({});

    // Image must be skipped (no DepRef emitted).
    expect(deps).toHaveLength(0);
    // Warning must be emitted.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not determine image range"));

    parseSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
