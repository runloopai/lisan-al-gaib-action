import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveCacheKey, SUPPORTED_ECOSYSTEMS, resolvePins, dedupeAndResolve, run, applyLicensePolicy } from "../src/update/run.js";
import type { RunOpts } from "../src/update/run.js";
import { reconcileConstantGroups } from "../src/update/reconcile-groups.js";
import { buildSelectionGroups } from "../src/update/select.js";
import { buildCandidates } from "../src/update/candidates.js";
import { buildAndApplyEdits } from "../src/update/write-pipeline.js";
import type { DepRef, UpdateCandidate } from "../src/update/types.js";
import type { RegistryUrls } from "../src/inputs.js";
import type { VersionRef } from "../src/ecosystems/types.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as applyModule from "../src/update/apply.js";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../src/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/registry.js")>();
  return {
    ...actual,
    ociDigestForTag: vi.fn(),
    fetchImagePublishDate: vi.fn(),
  };
});

vi.mock("../src/update/ecosystems/docker.js", () => ({
  discover: vi.fn().mockResolvedValue([]),
  buildFileEdits: vi.fn().mockReturnValue([]),
  rewriteKeyOf: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../src/update/latest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/update/latest.js")>();
  return { ...actual, resolveLatest: vi.fn() };
});

vi.mock("../src/license.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/license.js")>();
  return { ...actual, fetchLicense: vi.fn() };
});

import { cratesVersions } from "../src/registry.js";
import * as registry from "../src/registry.js";
import * as dockerUpdater from "../src/update/ecosystems/docker.js";
import * as latestModule from "../src/update/latest.js";
import { fetchLicense } from "../src/license.js";

describe("resolveCacheKey", () => {
  it("produces a stable key for simple names", () => {
    expect(resolveCacheKey("actions", "actions/checkout", "v4")).toBe(
      "actions|||actions/checkout|||v4",
    );
  });

  it("correctly handles digest-pinned OCI images whose version contains '@'", () => {
    // makeVersion returns "tag@sha256:abc" for digest-pinned images.
    // A colon-at-based key would split at the wrong '@', corrupting name/current.
    const name = "docker.io/library/nginx";
    const current = "1.21@sha256:abcdef1234567890";
    const key = resolveCacheKey("docker", name, current);
    expect(key).toBe(`docker|||${name}|||${current}`);

    // Verify the key uniquely round-trips through the ||| separator
    const parts = key.split("|||");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("docker");
    expect(parts[1]).toBe(name);
    expect(parts[2]).toBe(current);
  });

  it("produces distinct keys for different current versions of the same image", () => {
    const k1 = resolveCacheKey("docker", "docker.io/library/nginx", "1.20");
    const k2 = resolveCacheKey("docker", "docker.io/library/nginx", "1.21");
    expect(k1).not.toBe(k2);
  });
});

describe("reconcileConstantGroups (rust shared constant)", () => {
  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  // rust existence check mirrors run.ts's rustExistenceCheck.
  const rustExistenceCheck = async (name: string, version: string) => {
    const versions = await cratesVersions(name, REGISTRIES);
    return versions.some((v) => v.version === version);
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0",
    nodeStart: 100,
    nodeEnd: 105,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "SERDE_VERSION",
  };

  function makeRustDep(name: string): DepRef {
    return {
      ecosystem: "rust",
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeRustCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2024-12-01"),
      ageDays: 180,
      breaking: false,
      direction: "upgrade",
    };
  }

  beforeEach(() => vi.restoreAllMocks());

  it("drops the group when a referencing crate has no candidate and lacks the proposed version", async () => {
    const depSerde = makeRustDep("serde");
    const depSerdeJson = makeRustDep("serde_json"); // no candidate; lacks 1.0.200
    const filteredDeps = [depSerde, depSerdeJson];
    const candidates = [makeRustCandidate(depSerde, "1.0.200")];

    // serde_json's crates.io response does NOT contain 1.0.200.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ versions: [{ num: "1.0.100", created_at: "2024-01-01T00:00:00Z" }] }),
      ),
    );

    await reconcileConstantGroups(
      candidates, filteredDeps, new Map([["rust", rustExistenceCheck]]), new Map(), REGISTRIES, 14,
    );
    expect(candidates).toHaveLength(0);
  });

  it("keeps the group when the missing crate DOES have the proposed version", async () => {
    const depSerde = makeRustDep("serde");
    const depSerdeJson = makeRustDep("serde_json");
    const filteredDeps = [depSerde, depSerdeJson];
    const candidates = [makeRustCandidate(depSerde, "1.0.200")];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ versions: [{ num: "1.0.200", created_at: "2024-01-01T00:00:00Z" }] }),
      ),
    );

    // P1.2 age-gate: serde_json's proposed version must also pass the age gate. Use a
    // mock (not the real rustAgeCheck) to avoid a second cratesVersions fetch reading
    // the already-consumed mocked Response body a second time.
    const rustAgeCheck = vi.fn().mockResolvedValue(9999);

    await reconcileConstantGroups(
      candidates, filteredDeps, new Map([["rust", rustExistenceCheck]]), new Map([["rust", rustAgeCheck]]), REGISTRIES, 14,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].latest).toBe("1.0.200");
  });
});

describe("reconcileConstantGroups — cross-ecosystem constants", () => {
  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0",
    nodeStart: 50,
    nodeEnd: 55,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "MY_VERSION",
  };

  function makeDep(ecosystem: string, name: string): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-01-01"),
      ageDays: 200,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("drops group when the missing cross-ecosystem dep lacks the proposed version", async () => {
    // Java dep has a candidate; bazel dep (same constant) has no candidate and the
    // version doesn't exist on BCR. The group must be dropped entirely.
    const javaDep = makeDep("java", "com.example:foo");
    const bazelDep = makeDep("bazel", "my_bazel_module");
    const filteredDeps = [javaDep, bazelDep];
    const candidates = [makeCandidate(javaDep, "2.0.0")];

    const javaCheck = vi.fn().mockResolvedValue(true);  // java dep passes
    const bazelCheck = vi.fn().mockResolvedValue(false); // bazel dep lacks 2.0.0 on BCR

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["java", javaCheck], ["bazel", bazelCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(0);
    expect(bazelCheck).toHaveBeenCalledWith("my_bazel_module", "2.0.0", expect.any(Array), REGISTRIES);
  });

  it("keeps group when all cross-ecosystem deps have the proposed version", async () => {
    const javaDep = makeDep("java", "com.example:foo");
    const bazelDep = makeDep("bazel", "my_bazel_module");
    const filteredDeps = [javaDep, bazelDep];
    const candidates = [makeCandidate(javaDep, "2.0.0")];

    const javaCheck = vi.fn().mockResolvedValue(true);
    const bazelCheck = vi.fn().mockResolvedValue(true);
    // P1.2 age-gate: bazelDep is the missing dep being re-vetted, so its age check
    // must also pass for the group to survive.
    const bazelAgeCheck = vi.fn().mockResolvedValue(9999);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["java", javaCheck], ["bazel", bazelCheck]]),
      new Map([["bazel", bazelAgeCheck]]),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(1);
    expect(bazelCheck).toHaveBeenCalledWith("my_bazel_module", "2.0.0", expect.any(Array), REGISTRIES);
  });

  it("uses the per-dep ecosystem check (not a fixed ecosystem check) for each missing dep", async () => {
    // Rust dep has a candidate; java dep (same constant) has no candidate.
    // The java existence check must be called (not the rust one) for the java dep.
    const rustDep = makeDep("rust", "serde");
    const javaDep = makeDep("java", "com.example:bar");
    const filteredDeps = [rustDep, javaDep];
    const candidates = [makeCandidate(rustDep, "1.0.100")];

    const rustCheck = vi.fn().mockResolvedValue(true);
    const javaCheck = vi.fn().mockResolvedValue(false); // java dep lacks the version

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck], ["java", javaCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(0);
    expect(javaCheck).toHaveBeenCalledWith("com.example:bar", "1.0.100", expect.any(Array), REGISTRIES);
    expect(rustCheck).not.toHaveBeenCalled(); // rust dep had a candidate, no existence check needed
  });
});

describe("reconcileConstantGroups — candidatesWithDifferentLatest (M3)", () => {
  // M3: when two candidates in the same constant group resolve to different `latest` versions,
  // the semver-minimum is chosen as `proposedVersion`. The dep whose `latest !== proposedVersion`
  // must have its existence checked at `proposedVersion` in its own registry — not just
  // the deps with no candidate at all (missingDeps). A cross-ecosystem constant (e.g. rust=2.1.0,
  // java=2.0.0) must be dropped if 2.0.0 doesn't exist in crates.io for the rust dep.

  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0.0",
    nodeStart: 30,
    nodeEnd: 36,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "SHARED_VERSION",
  };

  function makeDep(ecosystem: string, name: string): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-06-01"),
      ageDays: 100,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("drops the group when the higher-version candidate lacks the proposed minimum in its registry", async () => {
    // java dep: latest = "2.0.0" (will be the min)
    // rust dep: latest = "2.1.0" → needs "2.0.0" checked in crates.io → fails → group dropped
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const javaCheck = vi.fn().mockResolvedValue(true);
    const rustCheck = vi.fn().mockResolvedValue(false); // 2.0.0 not on crates.io

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["java", javaCheck], ["rust", rustCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(0);
    // rust dep (the one with different latest) must be validated at the min version
    expect(rustCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
    // java dep already had latest === proposedVersion → no separate check needed
    expect(javaCheck).not.toHaveBeenCalled();
  });

  it("keeps the group when all candidates have the proposed minimum in their registries", async () => {
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const rustCheck = vi.fn().mockResolvedValue(true); // 2.0.0 exists
    // P1.2 age-gate: rustDep is being re-vetted at the min version, so its age check
    // must also pass for the group to survive.
    const rustAgeCheck = vi.fn().mockResolvedValue(9999);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck]]),
      new Map([["rust", rustAgeCheck]]),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(2);
    expect(rustCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
  });
});

describe("reconcileConstantGroups — versionCache fast path (P3 item D)", () => {
  // resolveEager/resolveLazy only ever emit a VersionInfo entry into a dep's cached `versions`
  // list after confirming it exists in the registry AND that it passed meetsMinAge against the
  // same minAgeDays threaded through reconcileConstantGroups. So when the dep being re-vetted
  // already has the proposed minimum in its own versionCache entry, that's a sound substitute
  // for a fresh existence+age round-trip — skip the live checks entirely. A cache miss (key
  // absent, or the proposed version not present in that dep's filtered/gated list) must still
  // fall through to the live check; mode/stability/flavor filtering can exclude an otherwise-
  // valid version from the cached list, so absence proves nothing.
  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0.0",
    nodeStart: 70,
    nodeEnd: 76,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "CACHE_FAST_PATH_VERSION",
  };

  function makeDep(ecosystem: string, name: string): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-06-01"),
      ageDays: 100,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("skips the live existence+age check when the dep's own versionCache already has the proposed version", async () => {
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const rustCheck = vi.fn().mockResolvedValue(true);
    const rustAgeCheck = vi.fn().mockResolvedValue(9999);

    const versionCache = new Map([
      [
        resolveCacheKey("rust", rustDep.name, rustDep.current),
        { versions: [{ version: "2.0.0", publishDate: new Date("2025-01-01"), ageDays: 9999 }], currentAgeDays: 9999 },
      ],
    ]);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck]]),
      new Map([["rust", rustAgeCheck]]),
      REGISTRIES,
      14,
      versionCache,
    );

    expect(candidates).toHaveLength(2);
    expect(rustCheck).not.toHaveBeenCalled();
    expect(rustAgeCheck).not.toHaveBeenCalled();
  });

  it("falls through to the live check when the proposed version is absent from the dep's versionCache (cache miss)", async () => {
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const rustCheck = vi.fn().mockResolvedValue(true);
    const rustAgeCheck = vi.fn().mockResolvedValue(9999);

    // versionCache entry exists for rustDep but its filtered/gated list doesn't contain
    // "2.0.0" (e.g. mode filtering excluded it) — must not be treated as a fast-path hit.
    const versionCache = new Map([
      [
        resolveCacheKey("rust", rustDep.name, rustDep.current),
        { versions: [{ version: "2.1.0", publishDate: new Date("2025-01-01"), ageDays: 9999 }], currentAgeDays: 9999 },
      ],
    ]);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck]]),
      new Map([["rust", rustAgeCheck]]),
      REGISTRIES,
      14,
      versionCache,
    );

    expect(candidates).toHaveLength(2);
    expect(rustCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
    expect(rustAgeCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
  });

  it("falls through to the live check when versionCache is omitted entirely (backward compatible)", async () => {
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const rustCheck = vi.fn().mockResolvedValue(true);
    const rustAgeCheck = vi.fn().mockResolvedValue(9999);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck]]),
      new Map([["rust", rustAgeCheck]]),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(2);
    expect(rustCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
  });
});

describe("reconcileConstantGroups — P1.2 age-gate / P1.3 all-prerelease drop", () => {
  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0.0",
    nodeStart: 60,
    nodeEnd: 66,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "AGE_GATE_VERSION",
  };

  function makeDep(ecosystem: string, name: string): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-06-01"),
      ageDays: 100,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("P1.2: drops the group when the proposed minimum exists but is too young in the other dep's registry", async () => {
    // java dep resolves to "2.0.0" (becomes the proposed minimum); rust dep resolves to
    // "2.1.0". The rust existence check confirms 2.0.0 exists on crates.io, but its age
    // check reports it as only 3 days old — below the 14-day minAgeDays gate. Existence-only
    // validation would have let this through (P1.2 regression); the age gate must drop it.
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [makeCandidate(javaDep, "2.0.0"), makeCandidate(rustDep, "2.1.0")];

    const rustCheck = vi.fn().mockResolvedValue(true); // 2.0.0 exists on crates.io
    const rustAgeCheck = vi.fn().mockResolvedValue(3); // but only 3 days old there

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", rustCheck]]),
      new Map([["rust", rustAgeCheck]]),
      REGISTRIES,
      14,
    );

    expect(candidates).toHaveLength(0);
    expect(rustCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
    expect(rustAgeCheck).toHaveBeenCalledWith("mylib", "2.0.0", expect.any(Array), REGISTRIES);
  });

  it("P1.3: drops the group when every candidate sharing the constant is a prerelease", async () => {
    // Both candidates resolved to prerelease versions. Falling back to a prerelease
    // minimum (the pre-fix behavior) would write a prerelease into the shared constant —
    // the group must be dropped instead.
    const javaDep = makeDep("java", "com.example:lib");
    const rustDep = makeDep("rust", "mylib");
    const filteredDeps = [javaDep, rustDep];
    const candidates = [
      makeCandidate(javaDep, "2.0.0-rc.1"),
      makeCandidate(rustDep, "2.0.0-beta.1"),
    ];

    await reconcileConstantGroups(candidates, filteredDeps, new Map(), new Map(), REGISTRIES, 14);

    expect(candidates).toHaveLength(0);
  });
});

describe("reconcileConstantGroups — existence check throws (M1 fail-closed)", () => {
  // M1: when the existence check for a missing dep throws (e.g. registry timeout or
  // network error), the group must be dropped (fail-closed) and reconcileConstantGroups
  // must not propagate the throw to its caller.

  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  const SHARED_VREF: VersionRef = {
    value: "1.0.0",
    nodeStart: 20,
    nodeEnd: 26,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "FOO_VERSION",
  };

  function makeDep(ecosystem: string, name: string): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: SHARED_VREF },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2025-01-01"),
      ageDays: 180,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("drops the group and does not throw when the existence check throws", async () => {
    const depA = makeDep("rust", "foo");
    const depB = makeDep("rust", "bar"); // no candidate; existence check will throw
    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "2.0.0")];

    const throwingCheck = vi.fn().mockRejectedValue(new Error("registry timeout"));

    // Must resolve (not throw) even though the existence check throws.
    await expect(
      reconcileConstantGroups(candidates, filteredDeps, new Map([["rust", throwingCheck]]), new Map(), REGISTRIES, 14),
    ).resolves.toBeUndefined();

    // The group was dropped (fail-closed).
    expect(candidates).toHaveLength(0);
  });
});

describe("reconcileConstantGroups — mixed-template guard (jackson-bug-class regression)", () => {
  // Regression: when two deps share a Starlark constant literal but interpolate it
  // under DIFFERENT templates (e.g. "4.%s" % VER and "1.%s" % VER), the two
  // reconciliation passes operated in different value-spaces:
  //   - reconcileConstantGroups chose semver-min of full `latest` values
  //   - reconcileConstantRewrites wrote semver-min of stripped constant values
  // The written constant could yield an effective version for one dep that was never
  // existence-checked, reopening the jackson-2.21.4 bug for non-uniform templates.
  // Fix: drop the group when templatePrefix or templateSuffix differs across deps.

  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  // Both deps point to the SAME constant literal (same nodeStart/nodeEnd),
  // but use different templatePrefix so their interpolated versions differ.
  function makeDepWithTemplate(
    ecosystem: string,
    name: string,
    templatePrefix: string,
    templateSuffix = "",
  ): DepRef {
    const vr: VersionRef = {
      value: "30.0",
      nodeStart: 200,
      nodeEnd: 206,
      templatePrefix,
      templateSuffix,
      constantName: "PROTO_VERSION",
    };
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: `${templatePrefix}30.0${templateSuffix}`,
      position: { file: "/repo/MODULE.bazel", versionRef: vr },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "minor",
      publishDate: new Date("2025-06-01"),
      ageDays: 100,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("drops the group when deps share a constant but use different templatePrefix (mixed-value-space bug)", async () => {
    // depA uses "4.%s" % PROTO_VERSION → latest "4.33.0"
    // depB uses "1.%s" % PROTO_VERSION → latest "1.2.0"
    // Same constant literal (nodeStart=200, nodeEnd=206) but different prefixes.
    // reconcileConstantGroups must drop the group rather than reconciling across spaces.
    const depA = makeDepWithTemplate("rust", "protobuf", "4.");
    const depB = makeDepWithTemplate("rust", "protobuf-lite", "1.");
    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "4.33.0"), makeCandidate(depB, "1.2.0")];

    const existenceCheck = vi.fn().mockResolvedValue(true); // never called — guard fires first

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", existenceCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );
    warnSpy.mockRestore();

    // Group must be dropped — no candidate survives
    expect(candidates).toHaveLength(0);
    // Existence check must NOT have been called (guard fires before any network request)
    expect(existenceCheck).not.toHaveBeenCalled();
  });

  it("drops the group when deps share a constant but use different templateSuffix", async () => {
    // Same constant but depA uses "prefix:%s:suffix-a" and depB uses "prefix:%s:suffix-b"
    const depA = makeDepWithTemplate("java", "com.example:foo", "prefix:", ":suffix-a");
    const depB = makeDepWithTemplate("java", "com.example:bar", "prefix:", ":suffix-b");
    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "prefix:2.0:suffix-a"), makeCandidate(depB, "prefix:2.0:suffix-b")];

    const existenceCheck = vi.fn().mockResolvedValue(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["java", existenceCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );
    warnSpy.mockRestore();

    expect(candidates).toHaveLength(0);
    expect(existenceCheck).not.toHaveBeenCalled();
  });

  it("keeps the group when all deps use the same template (uniform case — no regression)", async () => {
    // Both deps use empty templatePrefix/templateSuffix (the common case)
    const depA = makeDepWithTemplate("rust", "serde", "");
    const depB = makeDepWithTemplate("rust", "serde_derive", "");
    // Reset nodeStart/End to share the same literal
    (depA.position as { versionRef: VersionRef }).versionRef.nodeStart = 200;
    (depB.position as { versionRef: VersionRef }).versionRef.nodeStart = 200;
    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "2.0.0"), makeCandidate(depB, "2.0.0")];

    const existenceCheck = vi.fn().mockResolvedValue(true);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", existenceCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    // Both candidates survive — no drop
    expect(candidates).toHaveLength(2);
  });
});

describe("SUPPORTED_ECOSYSTEMS", () => {
  it("includes the six supported ecosystems", () => {
    for (const eco of ["actions", "docker", "kubernetes", "rust", "java", "bazel"]) {
      expect(SUPPORTED_ECOSYSTEMS.has(eco as never)).toBe(true);
    }
  });

  it("does not include npm, python, or multitool (v1 out-of-scope)", () => {
    for (const eco of ["npm", "python", "multitool"]) {
      expect(SUPPORTED_ECOSYSTEMS.has(eco as never)).toBe(false);
    }
  });
});

// ─── T6: exit-code contract (D1) ────────────────────────────────────────────
// The CLI must exit 1 ONLY when result.failed.length > 0. The prior bug had
// `|| result.noEdits.length > 0` which incorrectly failed CI for benign no-ops
// (template-incompatible refs, unresolvable digests, reconcile-dropped constants).

describe("exit-code contract (D1)", () => {
  // Encodes the exact condition used in cli.ts to map a RunResult to an exit code.
  function exitCode(r: { failed: unknown[]; noEdits: unknown[] }): 0 | 1 {
    return r.failed.length > 0 ? 1 : 0;
  }

  it("failed.length > 0 → exit 1", () => {
    expect(exitCode({ failed: [{}], noEdits: [] })).toBe(1);
  });

  it("noEdits alone → exit 0 (benign no-op, must not fail CI)", () => {
    expect(exitCode({ failed: [], noEdits: [{}] })).toBe(0);
  });

  it("failed + noEdits together → exit 1 (failed takes precedence)", () => {
    expect(exitCode({ failed: [{}], noEdits: [{}] })).toBe(1);
  });

  it("neither failed nor noEdits → exit 0", () => {
    expect(exitCode({ failed: [], noEdits: [] })).toBe(0);
  });

  it("the old (pre-D1) condition `failed || noEdits > 0` would have incorrectly failed for noEdits-only", () => {
    const oldCondition = (r: { failed: unknown[]; noEdits: unknown[] }) =>
      r.failed.length > 0 || r.noEdits.length > 0;
    // noEdits alone: old code → exit 1 (wrong); new code → exit 0 (correct)
    expect(oldCondition({ failed: [], noEdits: [{}] })).toBe(true);  // old: exit 1
    expect(exitCode({ failed: [], noEdits: [{}] })).toBe(0);          // new: exit 0
  });
});

// ─── buildSelectionGroups ────────────────────────────────────────────────────
// Shared Starlark constants (2+ candidates sharing the same constant key) must
// be collapsed into a single checkbox row so toggling one toggles all atomically.

describe("buildSelectionGroups", () => {
  const SHARED_VREF: VersionRef = {
    value: "1.0.0",
    nodeStart: 100,
    nodeEnd: 107,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "RULES_GO_VERSION",
  };

  function makeDepWithConstant(ecosystem: string, name: string, vref = SHARED_VREF): DepRef {
    return {
      ecosystem,
      name,
      file: "/repo/MODULE.bazel",
      current: "1.0.0",
      position: { file: "/repo/MODULE.bazel", versionRef: vref },
    };
  }

  function makeDepNoConstant(ecosystem: string, name: string): DepRef {
    return { ecosystem, name, file: "/repo/package.json", current: "1.0.0", position: {} };
  }

  function makeCandidate(dep: DepRef, latest: string, overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2025-01-01"),
      ageDays: 90,
      breaking: false,
      direction: "upgrade",
      ...overrides,
    };
  }

  it("empty input yields empty groups", () => {
    expect(buildSelectionGroups([])).toEqual({});
  });

  it("singleton (null key — npm dep) renders as one-element array value", () => {
    const dep = makeDepNoConstant("npm", "lodash");
    const c = makeCandidate(dep, "4.17.22");
    const groups = buildSelectionGroups([c]);
    expect(Object.keys(groups)).toEqual(["npm"]);
    expect(groups["npm"]).toHaveLength(1);
    expect(groups["npm"][0].value).toEqual([c]);
    expect(groups["npm"][0].label).toContain("lodash: 1.0.0 → 4.17.22");
  });

  it("two candidates sharing a constant are collapsed into one row", () => {
    const dep1 = makeDepWithConstant("bazel", "rules_go");
    const dep2 = makeDepWithConstant("bazel", "gazelle");
    const c1 = makeCandidate(dep1, "0.50.0");
    const c2 = makeCandidate(dep2, "0.50.0");
    const groups = buildSelectionGroups([c1, c2]);

    expect(Object.keys(groups)).toEqual(["bazel"]);
    expect(groups["bazel"]).toHaveLength(1);
    const opt = groups["bazel"][0];
    // Collapsed row value contains both candidates.
    expect(opt.value).toEqual([c1, c2]);
    // Label uses the constant name and the proposed (semver-min) version.
    expect(opt.label).toContain("RULES_GO_VERSION → 0.50.0 (2 packages)");
    // Hint lists both package names.
    expect(opt.hint).toContain("rules_go");
    expect(opt.hint).toContain("gazelle");
  });

  it("three-member group collapses to one row with correct count", () => {
    const dep1 = makeDepWithConstant("bazel", "rules_go");
    const dep2 = makeDepWithConstant("bazel", "gazelle");
    const dep3 = makeDepWithConstant("rust", "serde");
    const c1 = makeCandidate(dep1, "0.50.0");
    const c2 = makeCandidate(dep2, "0.50.0");
    const c3 = makeCandidate(dep3, "0.50.0");
    const groups = buildSelectionGroups([c1, c2, c3]);
    // Representative ecosystem = pickSemverMin winner (all same version → first = c1 = bazel).
    const allRows = Object.values(groups).flat();
    expect(allRows).toHaveLength(1);
    expect(allRows[0].value).toHaveLength(3);
    expect(allRows[0].label).toContain("(3 packages)");
  });

  it("single-member constant group (unique key) renders as individual row", () => {
    const UNIQUE_VREF: VersionRef = { ...SHARED_VREF, nodeStart: 999, nodeEnd: 1006, constantName: "UNIQUE_CONST" };
    const dep = makeDepWithConstant("bazel", "only_dep", UNIQUE_VREF);
    const c = makeCandidate(dep, "2.0.0");
    const groups = buildSelectionGroups([c]);
    expect(Object.keys(groups)).toEqual(["bazel"]);
    expect(groups["bazel"]).toHaveLength(1);
    // Single member — rendered as individual dep row, NOT using constant name.
    expect(groups["bazel"][0].label).toContain("only_dep: 1.0.0 → 2.0.0");
    expect(groups["bazel"][0].value).toEqual([c]);
  });

  it("mixed: shared group + singletons preserve input order", () => {
    const SHARED_VREF2: VersionRef = { ...SHARED_VREF, nodeStart: 200, nodeEnd: 207, constantName: "JACKSON_VERSION" };
    const npmDep = makeDepNoConstant("npm", "lodash");
    const dep1 = makeDepWithConstant("java", "com.fasterxml.jackson.core:jackson-core", SHARED_VREF2);
    const dep2 = makeDepWithConstant("java", "com.fasterxml.jackson.core:jackson-databind", SHARED_VREF2);
    const cNpm = makeCandidate(npmDep, "4.17.22");
    const c1 = makeCandidate(dep1, "2.18.0");
    const c2 = makeCandidate(dep2, "2.18.0");

    const groups = buildSelectionGroups([cNpm, c1, c2]);
    expect(Object.keys(groups)).toEqual(["npm", "java"]);
    expect(groups["npm"]).toHaveLength(1);
    expect(groups["java"]).toHaveLength(1);
    expect(groups["java"][0].value).toHaveLength(2);
    expect(groups["java"][0].label).toContain("JACKSON_VERSION → 2.18.0 (2 packages)");
  });

  it("collapsed row label includes ⚠ breaking when any member is breaking", () => {
    const dep1 = makeDepWithConstant("bazel", "rules_go");
    const dep2 = makeDepWithConstant("bazel", "gazelle");
    const c1 = makeCandidate(dep1, "1.0.0", { breaking: true, updateLevel: "major" });
    const c2 = makeCandidate(dep2, "1.0.0");
    const groups = buildSelectionGroups([c1, c2]);
    expect(groups["bazel"][0].label).toContain("⚠ breaking");
  });

  it("collapsed row label includes ⚠ license regresses when any member has licenseRegresses", () => {
    const dep1 = makeDepWithConstant("bazel", "rules_go");
    const dep2 = makeDepWithConstant("bazel", "gazelle");
    const c1 = makeCandidate(dep1, "1.0.0");
    const c2 = makeCandidate(dep2, "1.0.0", { licenseRegresses: true, licenseCurrent: "MIT", licenseNew: "GPL-3.0" });
    const groups = buildSelectionGroups([c1, c2]);
    expect(groups["bazel"][0].label).toContain("⚠ license regresses");
  });

  it("displayed version is semver-min of the group (the version actually written)", () => {
    // Two candidates for the same constant but with different latest versions:
    // rust resolves to 2.1.0, java to 2.0.0 → pickSemverMin chooses 2.0.0.
    const MIXED_VREF: VersionRef = { ...SHARED_VREF, nodeStart: 300, nodeEnd: 306, constantName: "GRPC_VERSION" };
    const rustDep = makeDepWithConstant("rust", "tonic", MIXED_VREF);
    const javaDep = makeDepWithConstant("java", "io.grpc:grpc-core", MIXED_VREF);
    const cRust = makeCandidate(rustDep, "2.1.0");
    const cJava = makeCandidate(javaDep, "2.0.0");
    const groups = buildSelectionGroups([cRust, cJava]);
    const allRows = Object.values(groups).flat();
    expect(allRows).toHaveLength(1);
    expect(allRows[0].label).toContain("GRPC_VERSION → 2.0.0 (2 packages)");
  });
});


describe("buildAndApplyEdits — post-reconcile candidate attribution (Major #1)", () => {
  // File layout (all ASCII chars, so byte offset === UTF-16 code-unit offset):
  //   A = "1.0.0"\n  → opening quote at offset 4, content 1.0.0 at 5–9, nodeEnd=10 (exclusive)
  //   B = "2.0.0"\n  → opening quote at offset 16, content 2.0.0 at 17–21, nodeEnd=22 (exclusive)
  const FILE_CONTENT = 'A = "1.0.0"\nB = "2.0.0"\n';

  // SHARED_VREF: nodeStart/nodeEnd point inside the quotes of A = "1.0.0"
  const SHARED_VREF: VersionRef = {
    value: "1.0.0", nodeStart: 5, nodeEnd: 10,
    templatePrefix: "", templateSuffix: "", quote: '"', constantName: "A",
  };
  // UNIQUE_VREF: points inside the quotes of B = "2.0.0"
  const UNIQUE_VREF: VersionRef = {
    value: "2.0.0", nodeStart: 17, nodeEnd: 22,
    templatePrefix: "", templateSuffix: "", quote: '"', constantName: "B",
  };

  let tmpFile: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisan-test-"));
    tmpFile = path.join(dir, "MODULE.bazel");
    await fs.writeFile(tmpFile, FILE_CONTENT, "utf8");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(tmpFile), { recursive: true }).catch(() => undefined);
  });

  function makeCand(name: string, ecosystem: string, vref: VersionRef, latest: string, versionPrefix?: string): UpdateCandidate {
    return {
      dep: {
        ecosystem,
        name,
        file: tmpFile,
        current: vref.value,
        position: { file: tmpFile, versionRef: vref, versionPrefix },
      },
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2025-01-01"),
      ageDays: 90,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("cross-ecosystem reconcile-dropped candidates land in noEdits; surviving candidate lands in actuallyApplied", async () => {
    // Cross-ecosystem scenario that triggers the pre-Major-#1 misclassification:
    //   candA (rust, versionPrefix "=") and candB (java, no specifier) both emit an
    //   OffsetRewrite for offset 4 into allEdits — one from rustUpdater.buildFileEdits,
    //   one from javaUpdater.buildFileEdits. Pass 9c's cross-ecosystem
    //   reconcileConstantRewrites then drops the group (= vs "" specifier conflict).
    //
    // Pre-fix: editOffsetsByFile was built from pre-reconcile allEdits, so offset 4 was
    //   present. Both candA and candB landed in candidatesWithAnyEdit and were wrongly
    //   classified as actuallyApplied when Pass 9d checked writtenRealpaths.
    // Post-fix: candidatesWithAnyEdit is built from post-reconcile survivingOffsetsByRealpath.
    //   Offset 4 was dropped → candA and candB correctly land in noEdits.
    const candA = makeCand("crate_a", "rust", SHARED_VREF, "1.2.0", "=");
    const candB = makeCand("group:artifact", "java", SHARED_VREF, "1.3.0", undefined);
    // candC targets a unique constant — no conflict, must be written normally.
    const candC = makeCand("crate_c", "rust", UNIQUE_VREF, "2.1.0", undefined);

    const { actuallyApplied, failed, noEdits } = await buildAndApplyEdits(
      [candA, candB, candC],
      "sha",
      false,
    );

    expect(failed).toHaveLength(0);
    expect(noEdits).toHaveLength(2);
    expect(noEdits).toContain(candA);
    expect(noEdits).toContain(candB);
    expect(actuallyApplied).toHaveLength(1);
    expect(actuallyApplied[0]).toBe(candC);

    // The shared constant A must be unchanged (conflict dropped it); B must be updated.
    const written = await fs.readFile(tmpFile, "utf8");
    expect(written).toContain('A = "1.0.0"');
    expect(written).toContain('B = "2.1.0"');
  });

  // N8: --dry-run must never write files, even when candidates would otherwise apply
  // cleanly with no conflicts (dryRun=true takes the early return before
  // stageAndCommitEdits is ever called).
  it("dryRun=true never writes to disk, even for a conflict-free candidate", async () => {
    const candC = makeCand("crate_c", "rust", UNIQUE_VREF, "2.1.0", undefined);

    const { actuallyApplied, failed, noEdits } = await buildAndApplyEdits([candC], "sha", true);

    expect(failed).toHaveLength(0);
    expect(noEdits).toHaveLength(0);
    expect(actuallyApplied).toHaveLength(0); // dry-run never populates actuallyApplied

    const contentAfter = await fs.readFile(tmpFile, "utf8");
    expect(contentAfter).toBe(FILE_CONTENT); // byte-for-byte unchanged
  });
});

// ---------------------------------------------------------------------------
// buildCandidates — --pin-unpinned policy
// ---------------------------------------------------------------------------

describe("buildCandidates — pin-unpinned policy", () => {
  const FIXED_DIGEST = "sha256:deadbeef000000000000000000000000000000000000000000000000deadbeef";

  /** Minimal RunOpts for buildCandidates (only the fields it actually reads). */
  function makeOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: [],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: false,
      dryRun: false,
      json: true,   // suppress console.warn noise in tests
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "off",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" },
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  /** Build a docker DepRef with the given current version string. */
  function makeDockerDep(current: string): DepRef {
    return {
      ecosystem: "docker",
      name: "docker.io/library/nginx",
      file: "/Dockerfile",
      current,
      position: {},
    };
  }

  /**
   * Build a versionCache entry for a pin-in-place OCI candidate.
   * `ageDays` is both currentAgeDays and versions[0].ageDays (they're the same for pin-in-place).
   */
  function makeCache(tag: string, ageDays: number | null, resolvedDigest?: string) {
    const key = resolveCacheKey("docker", "docker.io/library/nginx", tag);
    const entry = {
      versions: [{ version: tag, publishDate: null as Date | null, ageDays }],
      currentAgeDays: ageDays,
      pinInPlace: true as const,
      resolvedDigest,
    };
    return { key, entry };
  }

  it("pins a previously-unpinned image with unconfirmable date when pinUnpinned=true", () => {
    const tag = "1.27-alpine";
    const dep = makeDockerDep(tag);   // tag-only → unpinned
    const { key, entry } = makeCache(tag, null, FIXED_DIGEST);
    const versionCache = new Map([[key, entry]]);

    const candidates = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: true }));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pinnedTo).toBe(FIXED_DIGEST);
    expect(candidates[0].latest).toBe(tag);
  });

  it("pins a previously-unpinned image that is too young when pinUnpinned=true", () => {
    const tag = "1.27-alpine";
    const dep = makeDockerDep(tag);
    const { key, entry } = makeCache(tag, 3, FIXED_DIGEST);  // 3 days old < 14d min-age
    const versionCache = new Map([[key, entry]]);

    const candidates = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: true }));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pinnedTo).toBe(FIXED_DIGEST);
  });

  it("skips a previously-unpinned age-failing image when pinUnpinned=false", () => {
    const tag = "1.27-alpine";
    const dep = makeDockerDep(tag);
    const { key, entry } = makeCache(tag, null, FIXED_DIGEST);
    const versionCache = new Map([[key, entry]]);

    const candidates = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: false }));

    expect(candidates).toHaveLength(0);
  });

  it("does NOT bypass for an already-pinned image (dep.current contains @) even when pinUnpinned=true", () => {
    // Already-pinned ref: the age gate must stay fail-closed to prevent swapping in a too-young
    // new digest when the tag moves upstream.
    const tag = "1.27-alpine";
    const current = `${tag}@${FIXED_DIGEST}`;
    const dep = makeDockerDep(current);  // already pinned
    const { entry } = makeCache(tag, 3, FIXED_DIGEST);  // 3d < 14d min-age
    // The cache key uses dep.current for already-pinned images
    const pinnedKey = resolveCacheKey("docker", "docker.io/library/nginx", current);
    const versionCache = new Map([[pinnedKey, entry]]);

    const candidates = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: true }));

    expect(candidates).toHaveLength(0);
  });

  it("skips when no resolvedDigest is available even if pinUnpinned=true (nothing to write)", () => {
    const tag = "1.27-alpine";
    const dep = makeDockerDep(tag);
    const { key, entry } = makeCache(tag, null, undefined);  // no resolvedDigest
    const versionCache = new Map([[key, entry]]);

    const candidates = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: true }));

    expect(candidates).toHaveLength(0);
  });

  it("pins normally when age gate passes regardless of pinUnpinned value (control)", () => {
    const tag = "1.27-alpine";
    const dep = makeDockerDep(tag);
    const { key, entry } = makeCache(tag, 30, FIXED_DIGEST);  // 30d ≥ 14d min-age
    const versionCache = new Map([[key, entry]]);

    const candTrue = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: true }));
    const candFalse = buildCandidates([dep], versionCache, makeOpts({ pinUnpinned: false }));

    expect(candTrue).toHaveLength(1);
    expect(candFalse).toHaveLength(1);
    expect(candTrue[0].pinnedTo).toBe(FIXED_DIGEST);
    expect(candFalse[0].pinnedTo).toBe(FIXED_DIGEST);
  });
});

// ─── H3: resolvePins TOCTOU re-gate ──────────────────────────────────────────
// Verifies that when a mutable tag moves between resolveLatest (buildCandidates)
// and resolvePins (write time), the new digest's age is re-checked and the
// appropriate fail-closed behavior is enforced.

describe("resolvePins TOCTOU re-gate (H3)", () => {
  const PRE_RESOLVED = "sha256:aaaa0000000000000000000000000000000000000000000000000000000000001";
  const FRESH_DIGEST = "sha256:bbbb0000000000000000000000000000000000000000000000000000000000002";
  const OLD_DATE = new Date(Date.now() - 30 * 86_400_000); // 30 days ago (seeded as candidate default)
  const REFRESH_DATE = new Date(Date.now() - 20 * 86_400_000); // 20 days ago (deliberately ≠ OLD_DATE for fan-out test)
  const YOUNG_DATE = new Date(Date.now() - 2 * 86_400_000); // 2 days ago

  function makeOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: [],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: false,
      dryRun: false,
      json: true,
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "off",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" },
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  function makeDockerCandidate(currentDep: string, pinnedTo = PRE_RESOLVED): UpdateCandidate {
    return {
      dep: {
        ecosystem: "docker",
        name: "docker.io/library/nginx",
        file: "/Dockerfile",
        current: currentDep,
        position: {},
      },
      latest: "1.27",
      publishDate: OLD_DATE,
      ageDays: 30,
      breaking: false,
      direction: "upgrade" as const,
      updateLevel: "patch" as const,
      pinnedTo,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("already-pinned: tag moved to too-young digest → skip (pinCache null, fail-closed)", async () => {
    // dep.current includes "@" → already pinned; shouldBypassAgeGate must be false
    const candidate = makeDockerCandidate(`1.27@${PRE_RESOLVED}`);
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST); // tag moved
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(YOUNG_DATE); // only 2d old

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts({ pinUnpinned: true }));

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    expect(pinCache.get(cacheKey)).toBeNull(); // skipped — tag moved to too-young digest
  });

  it("previously-unpinned + pinUnpinned=true: tag moved to too-young → pin with warning", async () => {
    // dep.current is tag-only → wasUnpinned; shouldBypassAgeGate → accept with warning
    const candidate = makeDockerCandidate("1.27"); // no "@" → unpinned
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(YOUNG_DATE); // 2d old

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts({ pinUnpinned: true }));

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    expect(pinCache.get(cacheKey)).toBe(FRESH_DIGEST); // pinned despite being too young
  });

  it("previously-unpinned + pinUnpinned=false: tag moved to too-young → skip", async () => {
    const candidate = makeDockerCandidate("1.27");
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(YOUNG_DATE);

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts({ pinUnpinned: false }));

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    expect(pinCache.get(cacheKey)).toBeNull();
  });

  it("tag not moved: reuses pre-resolved digest without re-gating", async () => {
    // ociDigestForTag returns same as pinnedTo → no re-gate, use pre-resolved
    const candidate = makeDockerCandidate(`1.27@${PRE_RESOLVED}`);
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(PRE_RESOLVED); // unchanged

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts());

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    // fetchImagePublishDate should NOT have been called (no re-gate needed)
    expect(registry.fetchImagePublishDate).not.toHaveBeenCalled();
    expect(pinCache.get(cacheKey)).toBe(PRE_RESOLVED);
  });

  it("tag moved to old-enough digest: accepts fresh digest for already-pinned ref", async () => {
    const candidate = makeDockerCandidate(`1.27@${PRE_RESOLVED}`);
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(OLD_DATE); // 30d old, passes gate

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts());

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    expect(pinCache.get(cacheKey)).toBe(FRESH_DIGEST);
  });

  it("tag moved to old-enough digest: refreshed age propagated to all candidates sharing the cacheKey", async () => {
    // Two candidates for the same image in different files — same cacheKey.
    // Only the representative (first) runs the pin task; the fan-out loop at
    // run.ts:1142-1155 must propagate refreshedAgeByKey to the duplicate too.
    const candidate1 = makeDockerCandidate(`1.27@${PRE_RESOLVED}`);
    candidate1.dep.file = "/Dockerfile1";
    const candidate2 = makeDockerCandidate(`1.27@${PRE_RESOLVED}`);
    candidate2.dep.file = "/Dockerfile2";

    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST); // tag moved
    // REFRESH_DATE (20d) is deliberately different from the candidate seed (OLD_DATE, 30d)
    // so that the fan-out propagation is observable — if run.ts:1150-1154 were removed,
    // candidate2.publishDate would remain OLD_DATE and ageDays would remain 30.
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(REFRESH_DATE);

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate1, candidate2], pinCache, makeOpts());

    // Both candidates should resolve to the fresh digest via the fan-out loop.
    expect(candidate1.pinnedTo).toBe(FRESH_DIGEST);
    expect(candidate2.pinnedTo).toBe(FRESH_DIGEST);
    // publishDate must be the REFRESHED date (20d), not the stale seed (OLD_DATE, 30d).
    // candidate2 is only touched by the fan-out loop — this is the load-bearing assertion.
    expect(candidate2.publishDate).toBe(REFRESH_DATE);
    expect(candidate1.publishDate).toBe(REFRESH_DATE);
    // ageDays must be ≈20 (from REFRESH_DATE), not the stale seed of 30.
    expect(candidate2.ageDays).not.toBe(30);
    expect(candidate1.ageDays).toBe(candidate2.ageDays);
    // Registry was called only once despite two candidates sharing the key.
    expect(registry.ociDigestForTag).toHaveBeenCalledTimes(1);
    expect(registry.fetchImagePublishDate).toHaveBeenCalledTimes(1);
  });
});

// ─── B1: Leaked staged temps + B2: EACCES snapshot ──────────────────────────
// These tests exercise stageAndCommitEdits (via buildAndApplyEdits) with controlled
// failures to verify that:
//   B1: Staged temps that were never committed are unlinked on commitFailed.
//   B2: A file whose fs.readFile throws EACCES is NOT snapshotted, so rollback
//       never writes "" (truncating the file) in its place.

describe("stageAndCommitEdits — B1/B2 atomic-write edge cases", () => {
  // We use the Bazel/rust ecosystem since it makes offset-based rewrites using
  // real temp files via stageTemp/commitTemp, exercising the full 5a→5b pipeline.
  const FILE_CONTENT_A = 'A = "1.0.0"\n';
  const FILE_CONTENT_B = 'B = "2.0.0"\n';

  const VREF_A: VersionRef = {
    value: "1.0.0", nodeStart: 5, nodeEnd: 10,
    templatePrefix: "", templateSuffix: "", quote: '"', constantName: "A",
  };
  const VREF_B: VersionRef = {
    value: "2.0.0", nodeStart: 5, nodeEnd: 10,
    templatePrefix: "", templateSuffix: "", quote: '"', constantName: "B",
  };

  let tmpDir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lisan-b-test-"));
    fileA = path.join(tmpDir, "MODULE_A.bazel");
    fileB = path.join(tmpDir, "MODULE_B.bazel");
    await fs.writeFile(fileA, FILE_CONTENT_A, "utf8");
    await fs.writeFile(fileB, FILE_CONTENT_B, "utf8");
  });

  afterEach(async () => {
    // Restore file permissions before cleanup (in case B2 test left them 000).
    await fs.chmod(fileB, 0o644).catch(() => undefined);
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true }).catch(() => undefined);
  });

  function makeCand(name: string, file: string, vref: VersionRef, latest: string): UpdateCandidate {
    return {
      dep: {
        ecosystem: "rust",
        name,
        file,
        current: vref.value,
        position: { file, versionRef: vref },
      },
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2025-01-01"),
      ageDays: 90,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("B1: staged temps for uncommitted files are unlinked when commitTemp throws on 2nd file", async () => {
    // candA targets fileA, candB targets fileB.
    // commitTemp succeeds for fileA (written + rolled back), throws for fileB.
    // The staged-but-never-committed temp for fileB must be unlinked (B1 fix).
    //
    // Behavior after fix:
    //   - fileA: commit succeeded → rolled back to original → still in writtenRealpaths
    //     (classification uses writtenRealpaths; rollback is a best-effort side effect)
    //   - fileB: commit threw → failedRealpaths
    //   - fileB's staged temp: must not remain on disk (B1 cleanup)
    //
    // We spy on commitTemp: let the real implementation run for 1st call (fileA),
    // then throw for 2nd call (fileB), leaving fileB's temp un-renamed.
    const originalCommitTemp = applyModule.commitTemp;
    let callCount = 0;
    const commitSpy = vi.spyOn(applyModule, "commitTemp").mockImplementation(async (tmp, file) => {
      callCount++;
      if (callCount === 2) {
        // Intentionally do NOT rename tmp → file. Simulate rename failure.
        // The B1 fix must unlink this orphaned temp file.
        throw new Error("simulated commit failure");
      }
      return originalCommitTemp(tmp, file);
    });

    const candA = makeCand("crate_a", fileA, VREF_A, "1.1.0");
    const candB = makeCand("crate_b", fileB, VREF_B, "2.1.0");

    const { failed } = await buildAndApplyEdits([candA, candB], "sha", false);

    // fileB must be in failed (commit threw for it).
    expect(failed.some((c) => c.dep.file === fileB)).toBe(true);

    // fileA content: it was committed then rolled back, so it must be back to original.
    const contentA = await fs.readFile(fileA, "utf8");
    expect(contentA).toBe(FILE_CONTENT_A);

    // PRIMARY B1 ASSERTION: No .lisan-tmp-* files should remain in tmpDir.
    // Without the B1 fix, fileB's staged temp would be left on disk because the
    // commit loop `break`s before reaching it, and the old code only cleaned up
    // staged temps on staging failure (not commit failure).
    const remaining = await fs.readdir(tmpDir);
    const tmpFiles = remaining.filter((f) => f.includes("lisan-tmp"));
    expect(tmpFiles).toHaveLength(0);

    commitSpy.mockRestore();
  });

  it("B2: file with EACCES read error is not snapshotted — no empty-content rollback written", async () => {
    // fileB is made unreadable (chmod 000) before staging, simulating EACCES.
    // The B2 fix: since readFile returns an EACCES error (not ENOENT), originalContent
    // is set to null → snapshot is skipped → rollback cannot write "" to fileB.
    //
    // stageTemp writes to a NEW temp file (not reading the original), so staging still
    // succeeds even when the original is unreadable. commitTemp then throws for fileB
    // (also simulated), triggering rollback of fileA. The rollback loop must skip fileB
    // because it has no snapshot entry.
    //
    // We use OS chmod to make fileB unreadable — ESM native module spying is not
    // possible for node:fs/promises, so we use a real filesystem side-effect.
    await fs.chmod(fileB, 0o000);

    const originalCommitTemp = applyModule.commitTemp;
    let commitCallCount = 0;
    const commitSpy = vi.spyOn(applyModule, "commitTemp").mockImplementation(async (tmp, file) => {
      commitCallCount++;
      if (commitCallCount === 2) throw new Error("simulated commit failure");
      return originalCommitTemp(tmp, file);
    });

    const candA = makeCand("crate_a", fileA, VREF_A, "1.1.0");
    const candB = makeCand("crate_b", fileB, VREF_B, "2.1.0");

    await buildAndApplyEdits([candA, candB], "sha", false);

    // Restore permissions so we can read fileB.
    await fs.chmod(fileB, 0o644);

    // PRIMARY B2 ASSERTION: fileB must NOT be empty.
    // Without the B2 fix, the old `catch(() => "")` would snapshot fileB as "" despite
    // EACCES, and the rollback would write "" → truncate. With the fix, EACCES → null
    // → no snapshot → rollback skips fileB → content is unchanged (the original "B = ...").
    const contentB = await fs.readFile(fileB, "utf8");
    expect(contentB).not.toBe("");
    expect(contentB.length).toBeGreaterThan(0);

    commitSpy.mockRestore();
  });
});

// ─── H6: reconcileConstantGroups — read-only sibling group-drop ───────────────
// A candidate whose versionRef.readOnly === true (a rpartition-derived reference)
// must cause the entire constant group to be dropped. No candidate for that constant
// should reach buildEditsByEcosystem.

describe("reconcileConstantGroups — read-only sibling group-drop (H6)", () => {
  const REGISTRIES: RegistryUrls = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    crates: "https://crates.io",
    maven: "https://repo1.maven.org/maven2",
  };

  // Shared constant literal — same nodeStart/nodeEnd for all deps in the group.
  const BASE_VREF: VersionRef = {
    value: "2.20.7",
    nodeStart: 400,
    nodeEnd: 407,
    templatePrefix: "",
    templateSuffix: "",
    constantName: "JACKSON_VERSION",
  };

  // The read-only sibling: a rpartition-derived ref that derives "2.20" from "2.20.7".
  // It references the same constant literal but with readOnly: true.
  const READONLY_VREF: VersionRef = {
    ...BASE_VREF,
    value: "2.20",   // the lossy-derived value (major.minor only)
    readOnly: true,
  };

  function makeDep(name: string, vref: VersionRef): DepRef {
    return {
      ecosystem: "rust",
      name,
      file: "/repo/MODULE.bazel",
      current: vref.value,
      position: { file: "/repo/MODULE.bazel", versionRef: vref },
    };
  }

  function makeCandidate(dep: DepRef, latest: string): UpdateCandidate {
    return {
      dep,
      latest,
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: new Date("2025-01-01"),
      ageDays: 90,
      breaking: false,
      direction: "upgrade",
    };
  }

  it("drops the whole constant group when any dep has versionRef.readOnly=true", async () => {
    // depA: normal writable reference to JACKSON_VERSION → has candidate
    // depB: read-only rpartition-derived reference → marks group as unsafe
    const depA = makeDep("jackson-core", BASE_VREF);
    const depB = makeDep("jackson-lite", READONLY_VREF); // readOnly sibling, no candidate

    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "2.21.0")];

    // Existence check should never be called — guard fires before network requests.
    const existenceCheck = vi.fn().mockResolvedValue(true);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", existenceCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    // The entire group must be dropped — no candidates survive.
    expect(candidates).toHaveLength(0);
    // Existence check must NOT be called (group dropped before network phase).
    expect(existenceCheck).not.toHaveBeenCalled();
  });

  it("does not drop the group when no dep in the group has readOnly=true", async () => {
    // Both deps use normal (non-read-only) versionRefs — group should proceed normally.
    const depA = makeDep("jackson-core", BASE_VREF);
    const depB = makeDep("jackson-databind", BASE_VREF);

    const filteredDeps = [depA, depB];
    const candidates = [makeCandidate(depA, "2.21.0"), makeCandidate(depB, "2.21.0")];

    const existenceCheck = vi.fn().mockResolvedValue(true);

    await reconcileConstantGroups(
      candidates,
      filteredDeps,
      new Map([["rust", existenceCheck]]),
      new Map(),
      REGISTRIES,
      14,
    );

    // No readOnly sibling → group not dropped; both candidates survive.
    expect(candidates).toHaveLength(2);
  });
});

// ─── Task C: digest-dropped candidates appear in result.failed ────────────────
// When an OCI (docker/kubernetes) candidate's digest cannot be resolved after
// resolvePins (pinnedTo is undefined), it must appear in result.failed rather
// than being silently dropped. Verifies the digestDropped accumulation logic
// in run().

describe("run() — OCI candidate with unresolved digest lands in result.failed", () => {
  const DOCKER_DEP: DepRef = {
    ecosystem: "docker",
    name: "docker.io/library/nginx",
    file: "/Dockerfile",
    current: "1.27",   // tag-only (no "@") → mutable, candidate for pinning
    position: {},
  };

  function makeRunOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: ["docker"],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: true,
      dryRun: false,
      json: false,
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "off",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" } as RegistryUrls,
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Docker discover returns one dep (tag-only mutable image).
    vi.mocked(dockerUpdater.discover).mockResolvedValue([DOCKER_DEP]);

    // resolveLatest returns a pin-in-place entry: the "latest" version is the same
    // tag (no version bump), resolvedDigest is set from the registry lookup.
    const DIGEST = "sha256:aaaa0000000000000000000000000000000000000000000000000000aaaa0001";
    vi.mocked(latestModule.resolveLatest).mockResolvedValue({
      versions: [{ version: "1.27", publishDate: new Date(Date.now() - 30 * 86_400_000), ageDays: 30 }],
      currentAgeDays: 30,
      pinInPlace: true,
      resolvedDigest: DIGEST,
    });

    // ociDigestForTag returns null → digest resolution fails in resolvePins.
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(null);
  });

  it("candidate with unresolved digest appears in result.failed, not silently dropped", async () => {
    const result = await run(makeRunOpts());

    // The candidate must appear in failed (not silently dropped from all buckets).
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].dep.name).toBe("docker.io/library/nginx");

    // It must NOT appear in applied or noEdits.
    expect(result.applied).toHaveLength(0);
    expect(result.noEdits).toHaveLength(0);
  });
});

// ─── Task C2: dry-run with unresolved digest exits 0 (digestDropped → skipped) ─
// A plain --dry-run (non-json) with an unresolvable OCI digest must exit 0.
// Pre-fix: digestDropped was placed in result.failed unconditionally, so
// --dry-run exited 1 even though nothing was written — breaking the report-only
// contract CI relies on.

describe("run() — dry-run + unresolved digest: result.failed is empty (exit 0)", () => {
  const DOCKER_DEP: DepRef = {
    ecosystem: "docker",
    name: "docker.io/library/nginx",
    file: "/Dockerfile",
    current: "1.27",
    position: {},
  };

  function makeRunOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: ["docker"],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: true,
      dryRun: true,
      json: false,
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "off",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" } as RegistryUrls,
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dockerUpdater.discover).mockResolvedValue([DOCKER_DEP]);
    // No resolvedDigest → buildCandidates sets pinnedTo=undefined → resolvePins falls
    // into the else branch and calls ociDigestForTag directly (not the preResolved fallback).
    // If resolvedDigest were set, resolvePins would use it as a fallback when ociDigestForTag
    // returns null (via `null ?? preResolved`), and the candidate would NOT reach digestDropped.
    vi.mocked(latestModule.resolveLatest).mockResolvedValue({
      versions: [{ version: "1.27", publishDate: new Date(Date.now() - 30 * 86_400_000), ageDays: 30 }],
      currentAgeDays: 30,
      pinInPlace: true,
      resolvedDigest: undefined,
    });
    // ociDigestForTag returns null → resolvedPin=null → pinCache.set(key,null) → digestDropped
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(null);
    // Must re-mock after clearAllMocks; otherwise buildFileEdits returns undefined and throws
    // inside buildEditsByEcosystem, masking the digestDropped signal with a build failure.
    vi.mocked(dockerUpdater.buildFileEdits).mockReturnValue([]);
  });

  it("digestDropped candidate lands in result.skipped, not result.failed", async () => {
    const result = await run(makeRunOpts());

    // Nothing was written → failed must be empty so computeExitCode returns 0.
    expect(result.failed).toHaveLength(0);

    // The candidate must still appear somewhere so the caller can surface it.
    const inSkipped = result.skipped.some((c) => c.dep.name === "docker.io/library/nginx");
    expect(inSkipped).toBe(true);

    // Nothing applied in dry-run.
    expect(result.applied).toHaveLength(0);
  });
});

// ─── H2: dedupeAndResolve — resolve throw logged, not swallowed ──────────────
// Pre-fix: bare `catch {}` silently set null with no diagnostic, contradicting
// the comment that "per-task rejections are logged as warnings via runBatched".

describe("dedupeAndResolve — resolve throw is logged and sets null in result map (H2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets key → null and logs when resolveOne throws", async () => {
    const core = await import("@actions/core");
    const result = await dedupeAndResolve(
      [{ id: "pkg:a" }],
      (dep: { id: string }) => dep.id,
      async () => { throw new Error("registry down"); },
      1,
    );
    // Key must be present and null (not absent, which would silently drop the dep).
    expect(result.has("pkg:a")).toBe(true);
    expect(result.get("pkg:a")).toBeNull();
    // A diagnostic must have been emitted so the caller can see why the dep is missing.
    expect(vi.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining("resolve failed for pkg:a"),
    );
  });

  it("still returns successful results alongside failed ones", async () => {
    const core = await import("@actions/core");
    const result = await dedupeAndResolve(
      [{ id: "pkg:a" }, { id: "pkg:b" }],
      (dep: { id: string }) => dep.id,
      async (dep: { id: string }) => {
        if (dep.id === "pkg:a") throw new Error("timeout");
        return "resolved";
      },
      2,
    );
    expect(result.get("pkg:a")).toBeNull();
    expect(result.get("pkg:b")).toBe("resolved");
    expect(vi.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining("pkg:a"),
    );
  });

  // P2.2: the verify action passes core.warning as the logger so a failed registry
  // lookup surfaces as a GitHub annotation instead of debug-only core.info output.
  it("uses the provided logger instead of core.info when one is passed", async () => {
    const core = await import("@actions/core");
    const customLogger = vi.fn();
    const result = await dedupeAndResolve(
      [{ id: "pkg:a" }],
      (dep: { id: string }) => dep.id,
      async () => { throw new Error("registry down"); },
      1,
      customLogger,
    );
    expect(result.get("pkg:a")).toBeNull();
    expect(customLogger).toHaveBeenCalledWith(expect.stringContaining("resolve failed for pkg:a"));
    expect(vi.mocked(core.info)).not.toHaveBeenCalled();
  });
});

// ─── M1: resolvePins throw-path fail-closed ───────────────────────────────────
// Verifies that a thrown registry call inside a resolvePins task sets
// pinCache.set(key, null) rather than leaving the key absent. An absent key
// allows the candidate to retain its buildCandidates pre-resolved digest, which
// is the failure mode the TOCTOU re-gate exists to prevent.

describe("resolvePins — registry throw sets pinCache.set(key, null) (M1)", () => {
  const PRE_RESOLVED_M1 = "sha256:aaaa0000000000000000000000000000000000000000000000000000000000ff";
  const FRESH_DIGEST_M1  = "sha256:bbbb0000000000000000000000000000000000000000000000000000000000ff";

  function makeOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: [],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: false,
      dryRun: false,
      json: true,
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "off",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" },
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  function makeCandidate(current: string, pinnedTo?: string): UpdateCandidate {
    return {
      dep: {
        ecosystem: "docker" as const,
        name: "docker.io/library/nginx",
        file: "/Dockerfile",
        current,
        position: {},
      },
      latest: "1.27",
      publishDate: new Date(Date.now() - 30 * 86_400_000),
      ageDays: 30,
      breaking: false,
      direction: "upgrade" as const,
      updateLevel: "patch" as const,
      pinnedTo,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("ociDigestForTag throws (no preResolved) → pinCache.set(key, null), not absent", async () => {
    const candidate = makeCandidate("1.27"); // no preResolved digest
    vi.mocked(registry.ociDigestForTag).mockRejectedValue(new Error("registry timeout"));

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts());

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    // Key must be PRESENT (null), not absent. An absent key would let the candidate
    // retain its pre-resolved digest in the fan-out loop — the opposite of fail-closed.
    expect(pinCache.has(cacheKey)).toBe(true);
    expect(pinCache.get(cacheKey)).toBeNull();
  });

  it("fetchImagePublishDate throws during TOCTOU re-gate → pinCache.set(key, null)", async () => {
    const candidate = makeCandidate(`1.27@${PRE_RESOLVED_M1}`, PRE_RESOLVED_M1);
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FRESH_DIGEST_M1); // tag moved
    vi.mocked(registry.fetchImagePublishDate).mockRejectedValue(new Error("network error"));

    const pinCache = new Map<string, string | null>();
    await resolvePins([candidate], pinCache, makeOpts({ pinUnpinned: false }));

    const cacheKey = resolveCacheKey("docker", candidate.dep.name, candidate.latest);
    expect(pinCache.has(cacheKey)).toBe(true);
    expect(pinCache.get(cacheKey)).toBeNull();
  });
});

// ─── applyLicensePolicy — fetch-error fail-closed integration (M1) ───────────
// decideLicense's newLicenseFetchFailed branch is unit-tested directly in
// update-license.test.ts; this exercises the same invariant end-to-end through
// applyLicensePolicy, where a registry fetch failure on the NEW version's license
// must actually reach decideLicense as newLicenseFetchFailed=true (not silently
// collapse to "no license declared") and set candidate.licenseBlocked accordingly.

describe("applyLicensePolicy — fetch-error fail-closed (M1 integration)", () => {
  function makeOpts(overrides: Partial<RunOpts> = {}): RunOpts {
    return {
      ecosystems: [],
      mode: "major",
      style: "sha",
      minAgeDays: 14,
      yes: false,
      dryRun: false,
      json: true,
      exclude: [],
      allowDowngrade: "no",
      licensePolicy: "block",
      token: "",
      registries: { npm: "", pypi: "", crates: "", maven: "" },
      bcrUrl: "",
      pinUnpinned: true,
      ...overrides,
    };
  }

  function makeNpmCandidate(): UpdateCandidate {
    return {
      dep: {
        ecosystem: "npm" as const,
        name: "left-pad",
        file: "/package.json",
        current: "1.0.0",
        position: {},
      },
      latest: "1.1.0",
      publishDate: new Date(),
      ageDays: 30,
      breaking: false,
      direction: "upgrade" as const,
      updateLevel: "minor" as const,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("registry fetch error on the new version's license excludes the candidate under policy=block", async () => {
    const candidate = makeNpmCandidate();
    vi.mocked(fetchLicense).mockImplementation(async (spec) => {
      if (spec.version === candidate.latest) throw new Error("registry timeout");
      return "MIT";
    });

    const licenseMap = new Map<string, string | null>();
    await applyLicensePolicy([candidate], licenseMap, makeOpts());

    expect(candidate.licenseCurrent).toBe("MIT");
    expect(candidate.licenseNew).toBeNull();
    // Fail-closed: an unconfirmable new-version license is treated as blocked, not
    // silently promoted the way a genuine "no license declared" would be.
    expect(candidate.licenseBlocked).toBe(true);
  });

  it("registry fetch error on the new version's license does NOT block under policy=warn", async () => {
    const candidate = makeNpmCandidate();
    vi.mocked(fetchLicense).mockImplementation(async (spec) => {
      if (spec.version === candidate.latest) throw new Error("registry timeout");
      return "MIT";
    });

    const licenseMap = new Map<string, string | null>();
    await applyLicensePolicy([candidate], licenseMap, makeOpts({ licensePolicy: "warn" }));

    expect(candidate.licenseBlocked).toBe(false);
  });
});
