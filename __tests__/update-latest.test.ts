import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyUpdateLevel,
  filterByMode,
  applyAgeGate,
  computeAgeDays,
  isDowngrade,
  decideDowngrade,
  shaToTag,
  isPrerelease,
  passesStabilityGate,
  filterByStability,
  versionFlavor,
  filterByFlavor,
  resolveLatest,
} from "../src/update/latest.js";
import type { VersionInfo } from "../src/update/types.js";

// Mock registry so H1/resolveLazy tests can control fetcher and dateResolver behaviour.
// Existing tests in this file only exercise pure filter/classify functions and do not
// call registry, so the mock is harmless for them.
vi.mock("../src/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/registry.js")>();
  return {
    ...actual,
    mavenMetadataVersions: vi.fn(),
    mavenPublishDate: vi.fn(),
    bcrVersions: vi.fn(),
    bcrPublishDate: vi.fn(),
  };
});
import * as registry from "../src/registry.js";

function makeVersion(
  version: string,
  ageDays: number | null = null,
): VersionInfo {
  return {
    version,
    publishDate: ageDays !== null ? new Date(Date.now() - ageDays * 86_400_000) : null,
    ageDays,
  };
}

describe("classifyUpdateLevel", () => {
  it("returns major for 1.0.0 → 2.0.0", () => {
    expect(classifyUpdateLevel("1.0.0", "2.0.0")).toBe("major");
  });

  it("returns minor for 1.0.0 → 1.1.0", () => {
    expect(classifyUpdateLevel("1.0.0", "1.1.0")).toBe("minor");
  });

  it("returns patch for 1.0.0 → 1.0.1", () => {
    expect(classifyUpdateLevel("1.0.0", "1.0.1")).toBe("patch");
  });

  it("maps premajor to major: 1.0.0 → 2.0.0-alpha.1", () => {
    // semver.diff("1.0.0", "2.0.0-alpha.1") === "premajor"
    expect(classifyUpdateLevel("1.0.0", "2.0.0-alpha.1")).toBe("major");
  });

  it("maps preminor to minor: 0.1.0 → 0.2.0-beta.1", () => {
    // semver.diff("0.1.0", "0.2.0-beta.1") === "preminor"
    expect(classifyUpdateLevel("0.1.0", "0.2.0-beta.1")).toBe("minor");
  });

  it("maps prepatch to patch: 1.0.0 → 1.0.1-rc.1", () => {
    // semver.diff("1.0.0", "1.0.1-rc.1") === "prepatch"
    expect(classifyUpdateLevel("1.0.0", "1.0.1-rc.1")).toBe("patch");
  });

  it("maps prerelease to patch: 1.0.0-alpha.1 → 1.0.0-alpha.2", () => {
    // semver.diff("1.0.0-alpha.1", "1.0.0-alpha.2") === "prerelease"
    expect(classifyUpdateLevel("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe("patch");
  });

  it("returns major for non-semver versions (e.g. v3 → v4)", () => {
    expect(classifyUpdateLevel("v3", "v4")).toBe("major");
  });

  it("returns patch when semver.diff returns null (same version)", () => {
    // semver.diff("1.0.0", "1.0.0") === null
    expect(classifyUpdateLevel("1.0.0", "1.0.0")).toBe("patch");
  });

  it("returns major when current is non-semver", () => {
    expect(classifyUpdateLevel("not-valid", "1.0.0")).toBe("major");
  });

  it("returns major when latest is non-semver", () => {
    expect(classifyUpdateLevel("1.0.0", "not-valid")).toBe("major");
  });
});

describe("filterByMode", () => {
  it("mode=major: returns all versions including major changes", () => {
    const versions = [
      makeVersion("2.0.0", 30),
      makeVersion("1.1.0", 30),
      makeVersion("1.0.1", 30),
    ];
    const result = filterByMode(versions, "1.0.0", "major");
    expect(result).toHaveLength(3);
  });

  it("mode=minor: allows minor, preminor, patch, prepatch, prerelease, null diff", () => {
    const versions = [
      makeVersion("2.0.0", 30),   // major — excluded
      makeVersion("1.1.0", 30),   // minor — allowed
      makeVersion("1.0.1", 30),   // patch — allowed
    ];
    const result = filterByMode(versions, "1.0.0", "minor");
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.version)).toContain("1.1.0");
    expect(result.map((v) => v.version)).toContain("1.0.1");
    expect(result.map((v) => v.version)).not.toContain("2.0.0");
  });

  it("mode=minor: allows preminor change", () => {
    const versions = [makeVersion("0.2.0-beta.1", 30)]; // preminor
    const result = filterByMode(versions, "0.1.0", "minor");
    expect(result).toHaveLength(1);
  });

  it("mode=patch: only allows patch/prepatch/prerelease/null diff", () => {
    const versions = [
      makeVersion("2.0.0", 30),   // major — excluded
      makeVersion("1.1.0", 30),   // minor — excluded
      makeVersion("1.0.1", 30),   // patch — allowed
    ];
    const result = filterByMode(versions, "1.0.0", "patch");
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("1.0.1");
  });

  it("mode=patch: allows prepatch change", () => {
    const versions = [makeVersion("1.0.1-rc.1", 30)]; // prepatch
    const result = filterByMode(versions, "1.0.0", "patch");
    expect(result).toHaveLength(1);
  });

  it("mode=patch: allows prerelease change", () => {
    const versions = [makeVersion("1.0.0-alpha.2", 30)]; // prerelease
    const result = filterByMode(versions, "1.0.0-alpha.1", "patch");
    expect(result).toHaveLength(1);
  });

  it("non-semver current: returns all versions regardless of mode", () => {
    const versions = [
      makeVersion("2.0.0", 30),
      makeVersion("1.1.0", 30),
      makeVersion("not-semver", 30),
    ];
    const result = filterByMode(versions, "not-valid-semver", "patch");
    expect(result).toHaveLength(3);
  });

  it("versions with invalid semver are filtered out in patch mode", () => {
    const versions = [
      makeVersion("not-valid", 30),
      makeVersion("1.0.1", 30),
    ];
    const result = filterByMode(versions, "1.0.0", "patch");
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("1.0.1");
  });

  it("versions with invalid semver are filtered out in minor mode", () => {
    const versions = [
      makeVersion("garbage", 30),
      makeVersion("1.1.0", 30),
    ];
    const result = filterByMode(versions, "1.0.0", "minor");
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("1.1.0");
  });

  it("returns empty array when no versions match mode", () => {
    const versions = [makeVersion("2.0.0", 30), makeVersion("1.1.0", 30)];
    const result = filterByMode(versions, "1.0.0", "patch");
    expect(result).toHaveLength(0);
  });

  it("mode=patch with coercible current (v3): filters out v4 as major, passes v3.0.1", () => {
    const versions = [
      makeVersion("v4", 30),      // coerces to 4.0.0 vs 3.0.0 → major → excluded
      makeVersion("v3.0.1", 30),  // coerces to 3.0.1 vs 3.0.0 → patch → allowed
    ];
    const result = filterByMode(versions, "v3", "patch");
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("v3.0.1");
  });

  it("mode=minor with coercible current (1.21): allows 1.22, blocks 2.0.0", () => {
    const versions = [
      makeVersion("2.0.0", 30),  // major → excluded
      makeVersion("1.22", 30),   // coerces to 1.22.0 vs 1.21.0 → minor → allowed
    ];
    const result = filterByMode(versions, "1.21", "minor");
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("1.22");
  });

  it("mode=minor with coercible current (v3): filters out v4 as major", () => {
    const versions = [makeVersion("v4", 30)];
    const result = filterByMode(versions, "v3", "minor");
    expect(result).toHaveLength(0);
  });

  // ─── direction-aware magnitude classification (--allow-downgrade only) ─────
  // filterByMode runs upstream of the downgrade-selection logic in run.ts
  // (selectTargetEntry: `versions.find(isDowngrade)` over a mode-filtered,
  // newest-first list). semver.diff is symmetric — it grades by which semver
  // component differs, not by which argument is numerically larger — so these
  // tests pin down that a genuine downgrade is graded by the magnitude of the
  // step DOWN the same way an equivalent-magnitude upgrade would be graded,
  // rather than leaking a larger-magnitude downgrade through (or dropping a
  // genuine same-magnitude one) once combined with `--mode`.
  describe("--allow-downgrade only: magnitude-aware downgrade selection", () => {
    const current = "2.5.3";
    // Sorted newest-first, mirroring resolveEager/resolveLazy's output order.
    const mixed = [
      makeVersion("2.5.9", 30), // patch-level UPGRADE
      makeVersion("2.5.1", 30), // patch-level DOWNGRADE
      makeVersion("2.4.0", 30), // minor-level DOWNGRADE
      makeVersion("1.0.0", 30), // major-level DOWNGRADE
    ];

    // Mirrors run.ts's selectTargetEntry: the first entry (newest-first) that is
    // an actual downgrade from `current`.
    function findDowngrade(versions: VersionInfo[]): VersionInfo | undefined {
      return versions.find((v) => isDowngrade(current, v.version));
    }

    it("--mode patch: keeps only patch-magnitude entries and finds the patch-magnitude downgrade — minor/major downgrades never leak through", () => {
      const filtered = filterByMode(mixed, current, "patch");
      expect(filtered.map((v) => v.version)).toEqual(["2.5.9", "2.5.1"]);
      const found = findDowngrade(filtered);
      expect(found?.version).toBe("2.5.1");
    });

    it("--mode minor: keeps patch- and minor-magnitude entries (major-magnitude downgrade excluded)", () => {
      const filtered = filterByMode(mixed, current, "minor");
      expect(filtered.map((v) => v.version)).toEqual(["2.5.9", "2.5.1", "2.4.0"]);
      // Closest (smallest-magnitude) downgrade still wins when multiple qualify.
      const found = findDowngrade(filtered);
      expect(found?.version).toBe("2.5.1");
    });

    it("--mode minor: finds a minor-magnitude downgrade when it's the only one available (patch downgrade absent)", () => {
      const noPatchDowngrade = [
        makeVersion("2.5.9", 30), // patch-level UPGRADE
        makeVersion("2.4.0", 30), // minor-level DOWNGRADE
        makeVersion("1.0.0", 30), // major-level DOWNGRADE
      ];
      const filtered = filterByMode(noPatchDowngrade, current, "minor");
      expect(filtered.map((v) => v.version)).toEqual(["2.5.9", "2.4.0"]);
      const found = findDowngrade(filtered);
      expect(found?.version).toBe("2.4.0");
    });

    it("--mode patch: finds nothing when only minor/major-magnitude downgrades are available", () => {
      const noPatchDowngrade = [
        makeVersion("2.5.9", 30), // patch-level UPGRADE
        makeVersion("2.4.0", 30), // minor-level DOWNGRADE
        makeVersion("1.0.0", 30), // major-level DOWNGRADE
      ];
      const filtered = filterByMode(noPatchDowngrade, current, "patch");
      expect(filtered.map((v) => v.version)).toEqual(["2.5.9"]);
      expect(findDowngrade(filtered)).toBeUndefined();
    });
  });
});

describe("applyAgeGate", () => {
  it("excludes versions with ageDays === null (fail-closed on unknown publish date)", () => {
    const versions = [makeVersion("1.0.0", null)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(0);
  });

  it("excludes a zero-age version when minAgeDays > 0 (fail-closed)", () => {
    const versions = [makeVersion("1.0.0", 0)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(0);
  });

  it("passes versions with ageDays >= minAgeDays", () => {
    const versions = [makeVersion("1.0.0", 14), makeVersion("1.1.0", 30)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(2);
  });

  it("filters out versions with ageDays < minAgeDays", () => {
    const versions = [makeVersion("1.0.0", 5), makeVersion("1.1.0", 13)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(0);
  });

  it("exactly at minAgeDays boundary: passes", () => {
    const versions = [makeVersion("1.0.0", 14)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(1);
  });

  it("one below boundary: filtered out", () => {
    const versions = [makeVersion("1.0.0", 13)];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(0);
  });

  it("mix of null, passing, and filtered versions (fail-closed)", () => {
    const versions = [
      makeVersion("1.0.0", null),  // excluded (unknown — fail-closed)
      makeVersion("1.0.1", 20),    // passes (>= 14)
      makeVersion("1.0.2", 5),     // filtered out (< 14)
    ];
    const result = applyAgeGate(versions, 14);
    expect(result).toHaveLength(1);
    expect(result.map((v) => v.version)).not.toContain("1.0.0");
    expect(result.map((v) => v.version)).toContain("1.0.1");
    expect(result.map((v) => v.version)).not.toContain("1.0.2");
  });

  it("returns all versions for minAgeDays = 0", () => {
    const versions = [makeVersion("1.0.0", 0), makeVersion("1.0.1", 1)];
    const result = applyAgeGate(versions, 0);
    expect(result).toHaveLength(2);
  });
});

describe("computeAgeDays", () => {
  it("returns null for null input", () => {
    expect(computeAgeDays(null)).toBeNull();
  });

  it("returns null for invalid date", () => {
    expect(computeAgeDays(new Date("invalid"))).toBeNull();
  });

  it("returns non-negative integer for valid past date", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const result = computeAgeDays(tenDaysAgo);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("is approximately correct — within 1 day of expected", () => {
    const daysAgo = 30;
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    const result = computeAgeDays(date);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(daysAgo - 1);
    expect(result!).toBeLessThanOrEqual(daysAgo + 1);
  });

  it("returns 0 for a date just now (same ms)", () => {
    const now = new Date();
    const result = computeAgeDays(now);
    expect(result).toBe(0);
  });

  it("returns the floor of fractional days", () => {
    // 1.5 days ago → should return 1
    const date = new Date(Date.now() - 1.5 * 86_400_000);
    const result = computeAgeDays(date);
    expect(result).toBe(1);
  });
});

describe("isDowngrade", () => {
  it("upgrade: 1.0.0 → 1.0.1 is not a downgrade", () => {
    expect(isDowngrade("1.0.0", "1.0.1")).toBe(false);
  });

  it("downgrade: 1.0.1 → 1.0.0 is a downgrade", () => {
    expect(isDowngrade("1.0.1", "1.0.0")).toBe(true);
  });

  it("same version is not a downgrade", () => {
    expect(isDowngrade("1.0.0", "1.0.0")).toBe(false);
  });

  it("coercible non-semver: v4 → v3 is a downgrade", () => {
    expect(isDowngrade("v4", "v3")).toBe(true);
  });

  it("coercible non-semver: v3 → v4 is not a downgrade", () => {
    expect(isDowngrade("v3", "v4")).toBe(false);
  });

  it("both uncoercible returns false (unknown direction treated as upgrade)", () => {
    expect(isDowngrade("abc", "xyz")).toBe(false);
  });

  it("returns false when current is non-semver-valid but coercible and target is strict semver and newer: v3 vs 4.0.0", () => {
    // current "v3" coerces to 3.0.0, target "4.0.0" is strict semver > 3.0.0 → not a downgrade
    expect(isDowngrade("v3", "4.0.0")).toBe(false);
  });
});

describe("decideDowngrade", () => {
  const base = { minAgeDays: 14 };

  it("allowDowngrade=no, upgrade direction → keep:true", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.0",
      target: "1.0.1",
      currentAgeDays: 30,
      allowDowngrade: "no",
    })).toEqual({ keep: true, direction: "upgrade", violatesAge: false });
  });

  it("allowDowngrade=no, downgrade direction (currentAgeDays violates) → keep:false", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: 5,
      allowDowngrade: "no",
    })).toEqual({ keep: false, direction: "downgrade", violatesAge: true });
  });

  it("allowDowngrade=allow, upgrade direction → keep:true", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.0",
      target: "1.0.1",
      currentAgeDays: 30,
      allowDowngrade: "allow",
    })).toEqual({ keep: true, direction: "upgrade", violatesAge: false });
  });

  it("allowDowngrade=allow, downgrade direction (currentAgeDays violates) → keep:true", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: 5,
      allowDowngrade: "allow",
    })).toEqual({ keep: true, direction: "downgrade", violatesAge: true });
  });

  it("allowDowngrade=only, upgrade direction → keep:false", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.0",
      target: "1.0.1",
      currentAgeDays: 30,
      allowDowngrade: "only",
    })).toEqual({ keep: false, direction: "upgrade", violatesAge: false });
  });

  it("allowDowngrade=only, downgrade direction (currentAgeDays violates) → keep:true", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: 5,
      allowDowngrade: "only",
    })).toEqual({ keep: true, direction: "downgrade", violatesAge: true });
  });

  it("violatesAge boundary: currentAgeDays === minAgeDays → violatesAge:false", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: 14,  // exactly at boundary
      allowDowngrade: "no",
    })).toEqual({ keep: false, direction: "downgrade", violatesAge: false });
  });

  it("currentAgeDays: null → violatesAge:false", () => {
    expect(decideDowngrade({
      ...base,
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: null,
      allowDowngrade: "no",
    })).toEqual({ keep: false, direction: "downgrade", violatesAge: false });
  });

  it('allowDowngrade="no": downgrade direction even when current version is old enough → keep false, violatesAge false', () => {
    const result = decideDowngrade({
      current: "1.0.1",
      target: "1.0.0",
      currentAgeDays: 30,  // well above minimum, not violating
      minAgeDays: 14,
      allowDowngrade: "no",
    });
    expect(result).toEqual({ keep: false, direction: "downgrade", violatesAge: false });
  });
});

// ─── shaToTag ────────────────────────────────────────────────────────────────

function makeFetch(pages: Array<Array<{ name: string; commit: { sha: string } }>>): typeof fetch {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const page = pages[call++] ?? [];
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(page),
    });
  }) as unknown as typeof fetch;
}

describe("shaToTag", () => {
  const sha = "8f4b7f84864484a7bf31766abe9204da3cbe65b3";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the tag when exactly one version-parseable tag matches the SHA", async () => {
    vi.stubGlobal("fetch", makeFetch([
      [
        { name: "v4.1.1", commit: { sha } },
        { name: "v3.6.0", commit: { sha: "aabbccdd" } },
      ],
    ]));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBe("v4.1.1");
  });

  it("returns null when no tag matches the SHA", async () => {
    vi.stubGlobal("fetch", makeFetch([
      [{ name: "v4.1.1", commit: { sha: "deadbeef".repeat(5) } }],
    ]));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBeNull();
  });

  it("returns null when multiple version tags match the SHA (ambiguous)", async () => {
    vi.stubGlobal("fetch", makeFetch([
      [
        { name: "v4", commit: { sha } },
        { name: "v4.1.1", commit: { sha } },
      ],
    ]));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBeNull();
  });

  it("returns null when matching tag is not a parseable version (e.g. 'stable')", async () => {
    vi.stubGlobal("fetch", makeFetch([
      [{ name: "stable", commit: { sha } }],
    ]));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBeNull();
  });

  it("strips subpath from ownerRepo before querying (e.g. 'org/repo/path' → 'org/repo')", async () => {
    const mockFetch = makeFetch([[{ name: "v1.0.0", commit: { sha } }]]);
    vi.stubGlobal("fetch", mockFetch);
    await shaToTag("actions/checkout/.github", sha, "");
    const url = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/repos/actions/checkout/tags");
    expect(url).not.toContain("checkout/.github");
  });

  it("paginates across pages and finds match on second page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      name: `unrelated-${i}`,
      commit: { sha: `other${i}`.padEnd(40, "0") },
    }));
    vi.stubGlobal("fetch", makeFetch([
      fullPage,  // page 1: 100 unrelated tags
      [{ name: "v4.1.1", commit: { sha } }],  // page 2: the match
    ]));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBe("v4.1.1");
  });

  it("returns null on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await shaToTag("actions/checkout", sha, "");
    expect(result).toBeNull();
  });
});

// ─── isPrerelease ─────────────────────────────────────────────────────────────

describe("isPrerelease", () => {
  // Standard stable semver
  it("2.3.4 is not a prerelease", () => expect(isPrerelease("2.3.4")).toBe(false));
  it("v3 is not a prerelease", () => expect(isPrerelease("v3")).toBe(false));
  it("1.21 is not a prerelease", () => expect(isPrerelease("1.21")).toBe(false));

  // Standard semver prereleases
  it("1.0.0-rc.1 is a prerelease", () => expect(isPrerelease("1.0.0-rc.1")).toBe(true));
  it("2.0.0-alpha.1 is a prerelease", () => expect(isPrerelease("2.0.0-alpha.1")).toBe(true));
  it("3.0.0-beta.2 is a prerelease", () => expect(isPrerelease("3.0.0-beta.2")).toBe(true));
  it("1.0.0-0 (numeric-only prerelease) is a prerelease", () =>
    expect(isPrerelease("1.0.0-0")).toBe(true));

  // Non-semver prerelease forms
  it("3.0.0.beta1 is a prerelease", () => expect(isPrerelease("3.0.0.beta1")).toBe(true));
  it("1.0-SNAPSHOT is a prerelease", () => expect(isPrerelease("1.0-SNAPSHOT")).toBe(true));
  it("1.5.0.M1 is a prerelease", () => expect(isPrerelease("1.5.0.M1")).toBe(true));
  it("3.0.0-rc5 is a prerelease", () => expect(isPrerelease("3.0.0-rc5")).toBe(true));
  it("5.0.0.alpha1 is a prerelease", () => expect(isPrerelease("5.0.0.alpha1")).toBe(true));
  it("2.0.0-cr1 is a prerelease", () => expect(isPrerelease("2.0.0-cr1")).toBe(true));

  // Maven stable qualifiers — must NOT be flagged as prerelease
  it("2.0.0.RELEASE is not a prerelease", () => expect(isPrerelease("2.0.0.RELEASE")).toBe(false));
  it("5.3.0.Final is not a prerelease", () => expect(isPrerelease("5.3.0.Final")).toBe(false));
  it("6.0.0.GA is not a prerelease", () => expect(isPrerelease("6.0.0.GA")).toBe(false));
  it("2.0.0.SP1 is not a prerelease", () => expect(isPrerelease("2.0.0.SP1")).toBe(false));

  // Alpine packaging revisions (-rN) are stable rebuild revisions, not prereleases
  it("2.0.0-r2 is not a prerelease (Alpine stable revision)", () => expect(isPrerelease("2.0.0-r2")).toBe(false));
  it("2.0.0-r3 is not a prerelease (Alpine stable revision)", () => expect(isPrerelease("2.0.0-r3")).toBe(false));
  it("1.26.0-r1 is not a prerelease (Alpine stable revision)", () => expect(isPrerelease("1.26.0-r1")).toBe(false));

  // OCI image flavor suffixes are stable distribution variants, not prereleases
  it("1.24.0-alpine is not a prerelease", () => expect(isPrerelease("1.24.0-alpine")).toBe(false));
  it("3.11.6-slim is not a prerelease", () => expect(isPrerelease("3.11.6-slim")).toBe(false));
  it("16.1.0-bookworm is not a prerelease", () => expect(isPrerelease("16.1.0-bookworm")).toBe(false));
  it("3.11.6-slim-bullseye is not a prerelease", () => expect(isPrerelease("3.11.6-slim-bullseye")).toBe(false));

  // Unparseable / no numeric core → conservatively not prerelease
  it("unparseable string returns false", () => expect(isPrerelease("notaversion")).toBe(false));
});

// ─── passesStabilityGate ──────────────────────────────────────────────────────

describe("passesStabilityGate", () => {
  it("stable → stable: always allowed", () =>
    expect(passesStabilityGate("2.3.4", "3.0.0")).toBe(true));

  it("stable → prerelease: blocked (2.3.4 → 3.0.0-rc5)", () =>
    expect(passesStabilityGate("2.3.4", "3.0.0-rc5")).toBe(false));

  it("stable -rN → newer stable -rN (Alpine revisions): allowed (2.0.0-r2 → 2.0.0-r3)", () =>
    expect(passesStabilityGate("2.0.0-r2", "2.0.0-r3")).toBe(true));

  it("stable -rN → newer stable -rN across base: allowed (1.25.6-r3 → 1.26.0-r1)", () =>
    expect(passesStabilityGate("1.25.6-r3", "1.26.0-r1")).toBe(true));

  it("OCI flavor suffix (stable): 1.24.0-alpine → 1.25.3-alpine allowed", () =>
    expect(passesStabilityGate("1.24.0-alpine", "1.25.3-alpine")).toBe(true));

  it("stable -rN → prerelease of different base: blocked (2.0.0-r3 → 3.0.0.beta1)", () =>
    expect(passesStabilityGate("2.0.0-r3", "3.0.0.beta1")).toBe(false));

  it("prerelease → stable: always allowed (2.0.0-rc1 → 2.0.0)", () =>
    expect(passesStabilityGate("2.0.0-rc1", "2.0.0")).toBe(true));

  it("stable Maven .RELEASE → newer .RELEASE: allowed", () =>
    expect(passesStabilityGate("2.0.0.RELEASE", "3.0.0.RELEASE")).toBe(true));

  it("prerelease → same base semver stable: allowed (1.0.0-alpha.1 → 1.0.0)", () =>
    expect(passesStabilityGate("1.0.0-alpha.1", "1.0.0")).toBe(true));

  it("prerelease → higher base prerelease: blocked (1.0.0-rc1 → 1.1.0-rc1)", () =>
    expect(passesStabilityGate("1.0.0-rc1", "1.1.0-rc1")).toBe(false));
});

// ─── filterByStability ───────────────────────────────────────────────────────

describe("filterByStability", () => {
  it("stable current: drops all prerelease targets", () => {
    const versions: VersionInfo[] = [
      makeVersion("3.0.0-rc5"),
      makeVersion("3.0.0"),
      makeVersion("2.1.0"),
    ];
    const result = filterByStability(versions, "2.3.4");
    expect(result.map((v) => v.version)).toEqual(["3.0.0", "2.1.0"]);
  });

  it("stable current with -rN suffix: drops prerelease targets, keeps stable targets", () => {
    const versions: VersionInfo[] = [
      makeVersion("3.0.0.beta1"),   // prerelease → blocked (stable current → prerelease target)
      makeVersion("2.0.0-r3"),      // stable (-rN) → allowed
      makeVersion("2.0.0"),         // stable → allowed
    ];
    const result = filterByStability(versions, "2.0.0-r2");
    expect(result.map((v) => v.version)).toEqual(["2.0.0-r3", "2.0.0"]);
  });

  // Note: filterByStability does NOT constrain to the same flavor (that's filterByFlavor's job).
  // These tests verify stability gate only — cross-flavor stable candidates pass stability.
  it("stable OCI flavor current: cross-base flavor upgrade allowed, prerelease blocked", () => {
    const versions: VersionInfo[] = [
      makeVersion("1.25.3-alpine"),  // stable flavor → allowed across base
      makeVersion("1.24.0-rc1"),     // prerelease → blocked
      makeVersion("1.25.3"),         // stable → allowed
    ];
    const result = filterByStability(versions, "1.24.0-alpine");
    expect(result.map((v) => v.version)).toEqual(["1.25.3-alpine", "1.25.3"]);
  });

  it("returns all versions when current is stable and all targets are stable", () => {
    const versions = [makeVersion("2.0.0"), makeVersion("1.9.0")];
    const result = filterByStability(versions, "1.8.0");
    expect(result).toHaveLength(2);
  });

  it("empty input returns empty array", () => {
    expect(filterByStability([], "1.0.0")).toHaveLength(0);
  });
});

// ─── versionFlavor ────────────────────────────────────────────────────────────

describe("versionFlavor", () => {
  it("33.5.0-jre → 'jre'", () => expect(versionFlavor("33.5.0-jre")).toBe("jre"));
  it("33.6.0-android → 'android'", () => expect(versionFlavor("33.6.0-android")).toBe("android"));
  it("1.24.0-alpine → 'alpine'", () => expect(versionFlavor("1.24.0-alpine")).toBe("alpine"));
  it("33.6.0 (no qualifier) → null", () => expect(versionFlavor("33.6.0")).toBeNull());
  it("1.0.0 → null", () => expect(versionFlavor("1.0.0")).toBeNull());
  it("1.0.0-rc1 (prerelease) → null", () => expect(versionFlavor("1.0.0-rc1")).toBeNull());
  it("2.0.0-alpha.1 (prerelease) → null", () => expect(versionFlavor("2.0.0-alpha.1")).toBeNull());
  it("2.0.0.RELEASE (stable keyword) → null", () => expect(versionFlavor("2.0.0.RELEASE")).toBeNull());
  it("5.3.0.Final (stable keyword) → null", () => expect(versionFlavor("5.3.0.Final")).toBeNull());
  it("9.4.51.v20230217 (digit-bearing build qualifier) → null", () =>
    expect(versionFlavor("9.4.51.v20230217")).toBeNull());
  it("3.11.6-slim-bullseye (multi-token flavor) → 'slim-bullseye'", () =>
    expect(versionFlavor("3.11.6-slim-bullseye")).toBe("slim-bullseye"));
});

// ─── filterByFlavor ───────────────────────────────────────────────────────────

describe("filterByFlavor", () => {
  it("current with -jre flavor: keeps only -jre candidates (guava regression test)", () => {
    const versions = [
      makeVersion("33.6.0-jre"),
      makeVersion("33.6.0-android"),
      makeVersion("33.5.0-jre"),
    ];
    const result = filterByFlavor(versions, "33.5.0-jre");
    expect(result.map((v) => v.version)).toEqual(["33.6.0-jre", "33.5.0-jre"]);
  });

  it("current with -android flavor: keeps only -android candidates", () => {
    const versions = [
      makeVersion("33.6.0-jre"),
      makeVersion("33.6.0-android"),
      makeVersion("33.5.0-android"),
    ];
    const result = filterByFlavor(versions, "33.5.0-android");
    expect(result.map((v) => v.version)).toEqual(["33.6.0-android", "33.5.0-android"]);
  });

  it("current without flavor: returns all candidates unchanged", () => {
    const versions = [
      makeVersion("33.6.0"),
      makeVersion("33.5.0"),
      makeVersion("33.4.0-jre"),
    ];
    const result = filterByFlavor(versions, "33.5.0");
    expect(result).toHaveLength(3);
  });

  it("current with prerelease qualifier (no flavor): returns all unchanged", () => {
    const versions = [makeVersion("1.0.0-rc2"), makeVersion("1.0.0-rc1")];
    const result = filterByFlavor(versions, "1.0.0-rc1");
    expect(result).toHaveLength(2);
  });

  it("empty list returns empty list", () => {
    expect(filterByFlavor([], "33.5.0-jre")).toHaveLength(0);
  });
});

// ─── H1: resolveLazy current-age fail-closed ─────────────────────────────────
// Verifies that a transient registry throw while fetching the CURRENT version's
// age (used only for the downgrade advisory) does not suppress upgrade candidates.
// Pre-fix: the throw propagated out of resolveLazy; dedupeAndResolve caught it
// and nulled the whole dep — every upgrade was silently discarded.

describe("resolveLatest (java) — current-age dateResolver throw does not suppress upgrades (H1)", () => {
  const REGISTRIES = { npm: "", pypi: "", crates: "", maven: "https://repo1.maven.org/maven2" };
  const REPOS = ["https://repo1.maven.org/maven2"];

  beforeEach(() => vi.clearAllMocks());

  it("returns upgrade candidates even when the current-version date lookup throws", async () => {
    // mavenMetadataVersions returns two versions; publishDate is null so the lazy
    // dateResolver will be called for both the current ("1.0.0") and the candidate ("2.0.0").
    vi.mocked(registry.mavenMetadataVersions).mockResolvedValue([
      { version: "2.0.0", publishDate: null },
      { version: "1.0.0", publishDate: null },
    ]);
    // The current-version lookup (the advisory-only IIFE in resolveLazy) throws.
    // The main-loop candidate lookup for "2.0.0" succeeds with a 30-day-old date.
    vi.mocked(registry.mavenPublishDate).mockImplementation(async (_g, _a, version) => {
      if (version === "1.0.0") throw new Error("registry timeout — advisory fetch");
      return new Date(Date.now() - 30 * 86_400_000); // 30 days ago — passes age gate
    });

    const dep = {
      ecosystem: "java" as const,
      name: "org.example:artifact",
      file: "/MODULE.bazel",
      current: "1.0.0",
      position: {},
    };

    // resolveLatest must NOT throw — the advisory-fetch error should be swallowed.
    const result = await resolveLatest(dep, {
      mode: "major",
      minAgeDays: 14,
      allowDowngrade: "no",
      token: "",
      registries: REGISTRIES,
      javaRepositories: REPOS,
    });

    // "2.0.0" must survive as an upgrade candidate.
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].version).toBe("2.0.0");
    // currentAgeDays must be null (the throw → null contract), not an error.
    expect(result.currentAgeDays).toBeNull();
  });
});

// ─── resolveLatest (bazel/BCR) — lazy dateResolver null/throw paths ──────────
// bazel is the other resolveLazy consumer (alongside java) but had no direct test
// coverage of its own: bcrVersions/bcrPublishDate were mocked in this file but never
// exercised by a test. Covers both fail-closed branches of the per-version date loop
// (src/update/latest.ts resolveLazy): a resolved-but-null date (meetsMinAge rejects it,
// loop continues to the next-older version) vs. a thrown error (loop aborts the whole
// dep via `break`, never falling back to promoting an older, unverified version).

describe("resolveLatest (bazel/BCR) — lazy dateResolver null/throw paths", () => {
  const REGISTRIES = { npm: "", pypi: "", crates: "", maven: "" };

  beforeEach(() => vi.clearAllMocks());

  it("null publishDate (unresolvable date) is fail-closed: version skipped, older version tried", async () => {
    vi.mocked(registry.bcrVersions).mockResolvedValue([
      { version: "2.0.0", publishDate: null },
      { version: "1.0.0", publishDate: null },
    ]);
    vi.mocked(registry.bcrPublishDate).mockImplementation(async (_name, version) => {
      if (version === "2.0.0") return null; // resolved, but no date available — fail-closed
      return new Date(Date.now() - 30 * 86_400_000); // 1.0.0: 30 days old — passes
    });

    const dep = {
      ecosystem: "bazel" as const,
      name: "rules_foo",
      file: "/MODULE.bazel",
      current: "0.9.0",
      position: {},
    };

    const result = await resolveLatest(dep, {
      mode: "major",
      minAgeDays: 14,
      allowDowngrade: "no",
      token: "",
      registries: REGISTRIES,
    });

    // "2.0.0" is skipped (null date, fail-closed); "1.0.0" is the newest confirmable version.
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].version).toBe("1.0.0");
  });

  it("dateResolver throw on the newest version aborts the dep — does NOT fall back to an older version", async () => {
    vi.mocked(registry.bcrVersions).mockResolvedValue([
      { version: "2.0.0", publishDate: null },
      { version: "1.0.0", publishDate: null },
    ]);
    vi.mocked(registry.bcrPublishDate).mockImplementation(async (_name, version) => {
      if (version === "2.0.0") throw new Error("registry timeout");
      return new Date(Date.now() - 30 * 86_400_000); // 1.0.0 would otherwise qualify
    });

    const dep = {
      ecosystem: "bazel" as const,
      name: "rules_foo",
      file: "/MODULE.bazel",
      current: "0.9.0",
      position: {},
    };

    const result = await resolveLatest(dep, {
      mode: "major",
      minAgeDays: 14,
      allowDowngrade: "no",
      token: "",
      registries: REGISTRIES,
    });

    // The whole dep is dropped — a transient error must never be silently swallowed
    // into promoting the next-older version instead.
    expect(result.versions).toHaveLength(0);
  });
});
