import { describe, it, expect, vi } from "vitest";

const coreMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@actions/core", () => coreMock);

import {
  resolveConflictingReplaces,
  pickSemverMin,
} from "../src/update/ecosystems/bazel-shared.js";

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
