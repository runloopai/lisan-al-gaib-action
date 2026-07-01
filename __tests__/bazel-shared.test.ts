import { describe, it, expect, vi } from "vitest";

const coreMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@actions/core", () => coreMock);

import {
  resolveConflictingReplaces,
  pickSemverMin,
  reconcileConstantRewrites,
  buildConstantEditsForFile,
} from "../src/update/ecosystems/bazel-shared.js";
import type { BazelVersionPosition } from "../src/update/ecosystems/bazel-shared.js";
import type { OffsetRewrite, UpdateCandidate, DepRef } from "../src/update/types.js";
import type { VersionRef } from "../src/ecosystems/types.js";

// ─── L1: allComparable guard in resolveConflictingReplaces ───────────────────

describe("resolveConflictingReplaces — L1 all-exact-pin guard", () => {
  it("drops when all exact-pin specifiers but different versions", () => {
    // Two deps sharing a constant both use = specifier but want different versions.
    // Writing "=1.2.0" to a dep that requires "=2.0.0" would break it.
    const result = resolveConflictingReplaces(['"=1.2.0"', '"=2.0.0"'], 0, "test.bazel");
    expect(result).toBeNull();
  });

  it("allows when all exact-pin specifiers and same version", () => {
    // All deps agree on the same exact pin — safe to write it.
    const result = resolveConflictingReplaces(['"=1.2.0"', '"=1.2.0"'], 0, "test.bazel");
    expect(result).toBe('"=1.2.0"');
  });

  it("drops when exact-pin mixes with a range specifier", () => {
    // "=1.2.0" (exact) alongside "^2.0.0" (range) cannot be reconciled.
    const result = resolveConflictingReplaces(['"=1.2.0"', '"^2.0.0"'], 0, "test.bazel");
    expect(result).toBeNull();
  });

  it("picks semver minimum when versions are plain semver and no specifier conflict", () => {
    // No specifier prefixes — just plain semver; should pick the lower version.
    const result = resolveConflictingReplaces(['"2.0.0"', '"1.5.0"'], 0, "test.bazel");
    expect(result).toBe('"1.5.0"');
  });

  it("drops when inner versions are not semver-coercible", () => {
    // Non-semver values like "nightly" cannot be compared; the whole group must be dropped.
    const result = resolveConflictingReplaces(['"nightly"', '"stable"'], 0, "test.bazel");
    expect(result).toBeNull();
  });
});

// ─── L2: pickSemverMin prerelease filter ─────────────────────────────────────

describe("pickSemverMin — L2 prerelease handling", () => {
  it("returns the stable item when stable and prerelease are present", () => {
    // pickSemverMin uses semver.valid() (strict) so prerelease ordering is preserved:
    // 1.0.0-alpha.1 < 1.0.0 strictly. The stable 0.9.0 must win as the minimum.
    const items = [
      { v: "1.0.0-alpha.1" },
      { v: "0.9.0" },
    ];
    const result = pickSemverMin(items, (i) => i.v);
    expect(result?.v).toBe("0.9.0");
  });

  it("returns the prerelease item when it is strictly less than all stable items", () => {
    // 0.8.0-rc.1 < 0.9.0 strictly; prerelease must be selected as the minimum.
    const items = [
      { v: "0.9.0" },
      { v: "0.8.0-rc.1" },
    ];
    const result = pickSemverMin(items, (i) => i.v);
    expect(result?.v).toBe("0.8.0-rc.1");
  });

  it("returns null for an empty array", () => {
    expect(pickSemverMin([], (i: { v: string }) => i.v)).toBeNull();
  });

  it("returns the sole item when the array has one element", () => {
    expect(pickSemverMin([{ v: "1.0.0" }], (i) => i.v)?.v).toBe("1.0.0");
  });

  it("returns null when all versions fail to coerce (non-semver)", () => {
    // "nightly" and "edge" cannot be coerced; pickSemverMin must return null.
    const items = [{ v: "nightly" }, { v: "edge" }];
    expect(pickSemverMin(items, (i) => i.v)).toBeNull();
  });

  it("skips non-coercible versions and returns the minimum of those that can be coerced", () => {
    // "nightly" is skipped; minimum of "2.0.0" and "1.0.0" is "1.0.0".
    const items = [{ v: "nightly" }, { v: "2.0.0" }, { v: "1.0.0" }];
    const result = pickSemverMin(items, (i) => i.v);
    expect(result?.v).toBe("1.0.0");
  });

  it("handles 2-segment Maven/BCR versions via coerce", () => {
    // semver.valid("4.12") is null but semver.coerce("4.12") → "4.12.0"
    const items = [{ v: "4.13" }, { v: "4.12" }];
    const result = pickSemverMin(items, (i) => i.v);
    expect(result?.v).toBe("4.12");
  });
});

// ─── L3: reconcileConstantRewrites without templateKeys (fail-closed) ─────────
//
// When called without a templateKeys map (as in the cross-ecosystem merge in run.ts),
// reconcileConstantRewrites must be fail-closed: any offset group with differing
// replace values is dropped to avoid template-space corruption. Only groups where all
// rewrites agree on an identical replace string are allowed through.

describe("reconcileConstantRewrites — fail-closed when templateKeys absent", () => {
  function makeOffsetRewrite(offset: number, replace: string, expected = '"1.0.0"'): OffsetRewrite {
    return { offset, length: 7, replace, expected };
  }

  it("drops conflicting group (different replace values) when templateKeys is absent", () => {
    const rw1 = makeOffsetRewrite(10, '"1.2.0"');
    const rw2 = makeOffsetRewrite(10, '"1.3.0"'); // same offset, different replace
    const result = reconcileConstantRewrites([rw1, rw2], "MODULE.bazel");
    // No templateKeys → fail-closed: conflicting group must be dropped
    expect(result.rewrites).toHaveLength(0);
    expect(coreMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("templateKeys unavailable"),
    );
  });

  it("deduplicates when all rewrites in a group have identical replace values (exact-pin case)", () => {
    const rw1 = makeOffsetRewrite(10, '"1.2.0"');
    const rw2 = makeOffsetRewrite(10, '"1.2.0"'); // same offset, identical replace
    const result = reconcileConstantRewrites([rw1, rw2], "MODULE.bazel");
    // Identical replace → safe to deduplicate; exactly one rewrite survives
    expect(result.rewrites).toHaveLength(1);
    expect((result.rewrites[0] as OffsetRewrite).replace).toBe('"1.2.0"');
  });

  it("passes through non-conflicting groups (different offsets) unchanged", () => {
    const rw1 = makeOffsetRewrite(10, '"1.2.0"');
    const rw2 = makeOffsetRewrite(50, '"2.0.0"', '"2.0.0"'); // different offset
    const result = reconcileConstantRewrites([rw1, rw2], "MODULE.bazel");
    // Two distinct groups — each has one rewrite, both survive
    expect(result.rewrites).toHaveLength(2);
  });

  it("drops only the conflicting group, leaving non-conflicting groups intact", () => {
    const rwConflict1 = makeOffsetRewrite(10, '"1.2.0"');
    const rwConflict2 = makeOffsetRewrite(10, '"1.3.0"'); // conflict at offset 10
    const rwOk = makeOffsetRewrite(50, '"2.0.0"', '"2.0.0"'); // clean at offset 50
    const result = reconcileConstantRewrites([rwConflict1, rwConflict2, rwOk], "MODULE.bazel");
    // Conflicting group at offset 10 dropped; clean group at offset 50 survives
    expect(result.rewrites).toHaveLength(1);
    expect((result.rewrites[0] as OffsetRewrite).offset).toBe(50);
  });
});

// ─── N8a: buildConstantEditsForFile mixed-file guard ─────────────────────────

describe("buildConstantEditsForFile — mixed-file guard", () => {
  function makeCandidate(file: string, value: string): UpdateCandidate {
    const versionRef: VersionRef = {
      value,
      nodeStart: 10,
      nodeEnd: 10 + value.length,
      templatePrefix: "",
      templateSuffix: "",
    };
    const position: BazelVersionPosition = { file, versionRef };
    const dep: DepRef = { ecosystem: "bazel", name: "example", file, current: value, position };
    return {
      dep,
      latest: "2.0.0",
      updateLevel: "major",
      publishDate: null,
      ageDays: null,
      breaking: true,
      direction: "upgrade",
    };
  }

  it("skips a candidate whose dep.file does not match the file being processed", () => {
    coreMock.warning.mockClear();
    const good = makeCandidate("/repo/a/MODULE.bazel", "1.0.0");
    const mismatched = makeCandidate("/repo/b/MODULE.bazel", "1.0.0");

    const content = 'VERSION = "1.0.0"\n';
    const rewrites = buildConstantEditsForFile([good, mismatched], "/repo/a/MODULE.bazel", content);

    expect(rewrites).toHaveLength(1);
    expect(coreMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("does not match the file being processed"),
    );
  });
});
