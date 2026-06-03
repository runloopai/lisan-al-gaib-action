/**
 * Tests for ecosystem getChangedDeps and getPublishDate functions.
 * These mock git/fs/registry calls to test the orchestration logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/exec", () => ({
  exec: vi.fn(),
}));

vi.mock("@actions/glob", () => ({
  create: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/diff.js", () => ({
  resolveFiles: vi.fn(),
  gitDiff: vi.fn(),
  gitDiffFiltered: vi.fn(),
  gitDiffNameOnly: vi.fn(),
  gitShowFile: vi.fn(),
}));

vi.mock("../src/bazel.js", () => ({
  resolveModuleFiles: vi.fn(),
  extractCrateSpecs: vi.fn(),
  extractMavenInstalls: vi.fn(),
  extractOverrides: vi.fn(),
}));

vi.mock("../src/registry.js", () => ({
  mavenPublishDate: vi.fn(),
  cratesPublishDate: vi.fn(),
  npmPublishDate: vi.fn(),
  pypiPublishDate: vi.fn(),
  fetchImagePublishDate: vi.fn(),
  imageExists: vi.fn(),
}));

import * as fs from "node:fs/promises";
import * as diff from "../src/diff.js";
import * as bazel from "../src/bazel.js";
import * as registry from "../src/registry.js";

// ─── npm ecosystem ───────────────────────────────────────────────────────────

describe("npm.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-detects changed lockfiles", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["pnpm-lock.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(fs.readFile).mockResolvedValue(`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      express:
        specifier: ^4.18.2
        version: 4.18.2

packages:

  'express@4.18.2':
    resolution: {integrity: sha512-test}
` as any);

    const npm = await import("../src/ecosystems/npm.js");
    const deps = await npm.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("express");
  });

  it("returns empty when no lockfiles changed", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["src/main.ts"]);

    const npm = await import("../src/ecosystems/npm.js");
    const deps = await npm.getChangedDeps("HEAD~1", "");
    expect(deps).toEqual([]);
  });

  it("skips files with no diff", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["pnpm-lock.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("");

    const npm = await import("../src/ecosystems/npm.js");
    const deps = await npm.getChangedDeps("HEAD~1", "");
    expect(deps).toEqual([]);
  });

  it("uses provided lockfile input", async () => {
    vi.mocked(diff.resolveFiles).mockResolvedValue(["custom/lock.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(fs.readFile).mockResolvedValue(`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  'lodash@4.17.21':
    resolution: {integrity: sha512-test}
` as any);

    const npm = await import("../src/ecosystems/npm.js");
    const deps = await npm.getChangedDeps("HEAD~1", "custom/lock.yaml");
    expect(deps).toHaveLength(1);
  });
});

// ─── python ecosystem ────────────────────────────────────────────────────────

describe("python.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-detects changed lockfiles", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["uv.lock"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(fs.readFile).mockResolvedValue(`version = 1

[[package]]
name = "flask"
version = "3.0.0"
` as any);

    const python = await import("../src/ecosystems/python.js");
    const deps = await python.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("flask");
  });

  it("returns empty when no lockfiles changed", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([]);

    const python = await import("../src/ecosystems/python.js");
    const deps = await python.getChangedDeps("HEAD~1", "");
    expect(deps).toEqual([]);
  });

  it("filters to provided lockfiles", async () => {
    vi.mocked(diff.resolveFiles).mockResolvedValue(["custom/uv.lock"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["custom/uv.lock", "other.txt"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(fs.readFile).mockResolvedValue(`version = 1

[[package]]
name = "requests"
version = "2.31.0"
` as any);

    const python = await import("../src/ecosystems/python.js");
    const deps = await python.getChangedDeps("HEAD~1", "custom/uv.lock");
    expect(deps).toHaveLength(1);
  });
});

// ─── rust ecosystem ──────────────────────────────────────────────────────────

describe("rust.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds changed crate specs", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(fs.readFile).mockResolvedValue("head content" as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue("base content");
    vi.mocked(bazel.extractCrateSpecs)
      .mockResolvedValueOnce([
        { package: "serde", version: "1.0.200", isGit: false },
        { package: "tokio", version: "1.37.0", isGit: false },
      ])
      .mockResolvedValueOnce([
        { package: "serde", version: "1.0.200", isGit: false },
      ]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("tokio");
  });

  it("skips git-based crates", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(fs.readFile).mockResolvedValue("content" as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(bazel.extractCrateSpecs).mockResolvedValueOnce([
      { package: "my-crate", version: "0.1.0", isGit: true },
    ]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toEqual([]);
  });

  it("returns empty when no MODULE.bazel files found", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue([]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toEqual([]);
  });

  it("returns empty when no MODULE.bazel files changed", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["other.txt"]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toEqual([]);
  });

  it("resolves crate.spec range to concrete version from MODULE.bazel.lock", async () => {
    const lockJson = JSON.stringify({
      moduleExtensions: {
        "@@rules_rust+//crate_universe:extension.bzl%crate": {
          general: {
            generatedRepoSpecs: {
              "crates__tokio-1.37.0": {
                attributes: {
                  urls: ["https://static.crates.io/crates/tokio/1.37.0/download"],
                },
              },
            },
          },
        },
      },
    });

    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(fs.readFile).mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".lock")) {
        return Promise.resolve(lockJson as unknown as Buffer);
      }
      return Promise.resolve("head content" as unknown as Buffer);
    });
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(bazel.extractCrateSpecs).mockResolvedValueOnce([
      { package: "tokio", version: "~1.37.0", isGit: false },
    ]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("tokio");
    expect(deps[0].version).toBe("1.37.0");
  });

  it("skips crate whose resolved version was already in base lockfile (no-op range edit)", async () => {
    const prost013 = JSON.stringify({
      moduleExtensions: {
        "@@rules_rust+//crate_universe:extension.bzl%crate": {
          general: {
            generatedRepoSpecs: {
              "crates__prost-0.13.5": {
                attributes: {
                  urls: ["https://static.crates.io/crates/prost/0.13.5/download"],
                },
              },
            },
          },
        },
      },
    });

    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(fs.readFile).mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".lock")) {
        return Promise.resolve(prost013 as unknown as Buffer);
      }
      return Promise.resolve("head content" as unknown as Buffer);
    });
    vi.mocked(diff.gitShowFile).mockImplementation((_ref: string, p: string) => {
      if (p.endsWith(".lock")) return Promise.resolve(prost013);
      return Promise.resolve("base content");
    });
    // Head: ~0.13.5 (range edit), base: ^0.13.5 — both resolve to the same 0.13.5 already on base.
    vi.mocked(bazel.extractCrateSpecs)
      .mockResolvedValueOnce([{ package: "prost", version: "~0.13.5", isGit: false }])
      .mockResolvedValueOnce([{ package: "prost", version: "^0.13.5", isGit: false }]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toEqual([]);
  });

  it("flags crate whose resolved version is genuinely new vs base lockfile", async () => {
    const headLock = JSON.stringify({
      moduleExtensions: {
        "@@rules_rust+//crate_universe:extension.bzl%crate": {
          general: {
            generatedRepoSpecs: {
              "crates__prost-0.14.3": {
                attributes: {
                  urls: ["https://static.crates.io/crates/prost/0.14.3/download"],
                },
              },
            },
          },
        },
      },
    });
    const baseLock = JSON.stringify({
      moduleExtensions: {
        "@@rules_rust+//crate_universe:extension.bzl%crate": {
          general: {
            generatedRepoSpecs: {
              "crates__prost-0.13.5": {
                attributes: {
                  urls: ["https://static.crates.io/crates/prost/0.13.5/download"],
                },
              },
            },
          },
        },
      },
    });

    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(fs.readFile).mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".lock")) {
        return Promise.resolve(headLock as unknown as Buffer);
      }
      return Promise.resolve("head content" as unknown as Buffer);
    });
    vi.mocked(diff.gitShowFile).mockImplementation((_ref: string, p: string) => {
      if (p.endsWith(".lock")) return Promise.resolve(baseLock);
      return Promise.resolve("base content");
    });
    // Head: ~0.14.0 resolves to 0.14.3 (new), base: ~0.13.5 resolves to 0.13.5 (old).
    vi.mocked(bazel.extractCrateSpecs)
      .mockResolvedValueOnce([{ package: "prost", version: "~0.14.0", isGit: false }])
      .mockResolvedValueOnce([{ package: "prost", version: "~0.13.5", isGit: false }]);

    const rust = await import("../src/ecosystems/rust.js");
    const deps = await rust.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("prost");
    expect(deps[0].version).toBe("0.14.3");
  });
});

// ─── java ecosystem ─────────────────────────────────────────────────────────

describe("java.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds changed maven artifacts", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(bazel.extractMavenInstalls).mockResolvedValue([
      {
        name: "maven",
        lockFile: "maven_install.json",
        repositories: ["https://repo1.maven.org/maven2"],
        artifacts: [],
      },
    ]);
    vi.mocked(diff.gitShowFile).mockResolvedValue(
      JSON.stringify({ artifacts: { "com.google:guava": { version: "32.0.0" } } }),
    );
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce("content" as any)
      .mockResolvedValueOnce(
        JSON.stringify({
          artifacts: {
            "com.google:guava": { version: "33.0.0" },
            "com.fasterxml:jackson": { version: "2.15.0" },
          },
        }) as any,
      );

    const java = await import("../src/ecosystems/java.js");
    const result = await java.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(result.deps).toHaveLength(2);
    expect(result.repositories.get("com.google:guava")).toEqual([
      "https://repo1.maven.org/maven2",
    ]);
  });

  it("returns empty when no maven.install blocks", async () => {
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(bazel.extractMavenInstalls).mockResolvedValue([]);
    vi.mocked(fs.readFile).mockResolvedValue("content" as any);

    const java = await import("../src/ecosystems/java.js");
    const result = await java.getChangedDeps("HEAD~1", "MODULE.bazel");
    expect(result.deps).toEqual([]);
  });

  it("getPublishDate splits name correctly", async () => {
    vi.mocked(registry.mavenPublishDate).mockResolvedValue(new Date("2024-01-01"));

    const java = await import("../src/ecosystems/java.js");
    const date = await java.getPublishDate("com.google:guava", "33.0.0", [], {
      npm: "",
      pypi: "",
      crates: "",
      maven: "https://repo1.maven.org/maven2",
    });
    expect(date).toEqual(new Date("2024-01-01"));
    expect(registry.mavenPublishDate).toHaveBeenCalledWith(
      "com.google", "guava", "33.0.0", [], expect.anything(),
    );
  });

  it("getPublishDate returns null for invalid name", async () => {
    const java = await import("../src/ecosystems/java.js");
    const date = await java.getPublishDate("invalid", "1.0", [], {
      npm: "", pypi: "", crates: "", maven: "",
    });
    expect(date).toBeNull();
  });
});

// ─── bazel-module ecosystem ──────────────────────────────────────────────────

describe("bazel-module.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds changed modules from lockfile", async () => {
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(
      JSON.stringify({
        moduleDepGraph: {
          "rules_java@7.0.0": { name: "rules_java", version: "7.0.0" },
        },
      }),
    );
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(bazel.extractOverrides).mockResolvedValue(new Map());
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          moduleDepGraph: {
            "rules_java@8.12.0": { name: "rules_java", version: "8.12.0" },
            "protobuf@29.3": { name: "protobuf", version: "29.3" },
          },
        }) as any,
      )
      .mockResolvedValueOnce("" as any);

    const bazelModule = await import("../src/ecosystems/bazel-module.js");
    const result = await bazelModule.getChangedDeps("HEAD~1", "MODULE.bazel", "MODULE.bazel.lock");
    expect(result.deps).toHaveLength(2);
  });

  it("returns empty when lockfile not changed", async () => {
    vi.mocked(diff.gitDiff).mockResolvedValue("");

    const bazelModule = await import("../src/ecosystems/bazel-module.js");
    const result = await bazelModule.getChangedDeps("HEAD~1", "MODULE.bazel", "MODULE.bazel.lock");
    expect(result.deps).toEqual([]);
  });

  it("skips local_path_override modules", async () => {
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(JSON.stringify({ moduleDepGraph: {} }));
    vi.mocked(bazel.resolveModuleFiles).mockResolvedValue(["MODULE.bazel"]);
    vi.mocked(bazel.extractOverrides).mockResolvedValue(
      new Map([["local_mod", { type: "local_path" as const, moduleName: "local_mod" }]]),
    );
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          moduleDepGraph: {
            "local_mod@1.0.0": { name: "local_mod", version: "1.0.0" },
          },
        }) as any,
      )
      .mockResolvedValueOnce("" as any);

    const bazelModule = await import("../src/ecosystems/bazel-module.js");
    const result = await bazelModule.getChangedDeps("HEAD~1", "MODULE.bazel", "MODULE.bazel.lock");
    expect(result.deps).toEqual([]);
  });
});

// ─── actions ecosystem ───────────────────────────────────────────────────────

describe("actions.getChangedDeps", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear module-level caches so each test starts with no cached SHA resolutions.
    const actionsModule = await import("../src/ecosystems/actions.js");
    actionsModule.__resetCaches();
  });

  it("finds changed action refs in workflow files", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([".github/workflows/ci.yml"]);
    vi.mocked(diff.resolveFiles).mockResolvedValue([".github/workflows/ci.yml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(`
steps:
  - uses: actions/checkout@v3
`);
    vi.mocked(fs.readFile).mockResolvedValue(`
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
` as any);
    // checkout v3 and v4 resolve to different SHAs → both deps are flagged.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "0000000000000000000000000000000000000004" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "0000000000000000000000000000000000000003" })));

    const actions = await import("../src/ecosystems/actions.js");
    const deps = await actions.getChangedDeps("HEAD~1", ".github/workflows/*.yml", "");
    expect(deps).toHaveLength(2);
  });

  it("returns empty when no workflow files changed", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([]);
    vi.mocked(diff.resolveFiles).mockResolvedValue([".github/workflows/ci.yml"]);

    const actions = await import("../src/ecosystems/actions.js");
    const deps = await actions.getChangedDeps("HEAD~1", ".github/workflows/*.yml");
    expect(deps).toEqual([]);
  });

  it("skips action when ref change points to the same commit SHA", async () => {
    const sameSha = "dddddddddddddddddddddddddddddddddddddddd";
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([".github/workflows/deploy.yml"]);
    vi.mocked(diff.resolveFiles).mockResolvedValue([".github/workflows/deploy.yml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(`
steps:
  - uses: actions/deploy-pages@v1
  - uses: actions/configure-pages@v5
`);
    vi.mocked(fs.readFile).mockResolvedValue(`
steps:
  - uses: actions/deploy-pages@v1.1.0
  - uses: actions/configure-pages@v5
` as any);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: sameSha })))  // deploy-pages v1.1.0
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: sameSha }))); // deploy-pages v1 — same commit

    const actions = await import("../src/ecosystems/actions.js");
    const deps = await actions.getChangedDeps("HEAD~1", ".github/workflows/deploy.yml", "token");
    // deploy-pages ref changed but resolves to the same commit → skipped.
    // configure-pages unchanged (same key in base and head) → skipped by key check.
    expect(deps).toEqual([]);
  });

  it("flags action conservatively when SHA resolution fails", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([".github/workflows/upload.yml"]);
    vi.mocked(diff.resolveFiles).mockResolvedValue([".github/workflows/upload.yml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(diff.gitShowFile).mockResolvedValue(`
steps:
  - uses: actions/upload-artifact@v3
`);
    vi.mocked(fs.readFile).mockResolvedValue(`
steps:
  - uses: actions/upload-artifact@v4
` as any);
    // SHA resolution fails for both refs → headSha is null → flag conservatively.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    const actions = await import("../src/ecosystems/actions.js");
    const deps = await actions.getChangedDeps("HEAD~1", ".github/workflows/upload.yml", "token");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("actions/upload-artifact");
    expect(deps[0].version).toBe("v4");
  });

  it("skips action when SHA-pinned base matches tag head; no fetch for SHA ref (short-circuit)", async () => {
    const sha = "aaaa000000000000000000000000000000000000";
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue([".github/workflows/cache.yml"]);
    vi.mocked(diff.resolveFiles).mockResolvedValue([".github/workflows/cache.yml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    // Base is pinned to a commit SHA; head upgrades to a named tag resolving to that same SHA.
    vi.mocked(diff.gitShowFile).mockResolvedValue(
      `steps:\n  - uses: actions/cache@${sha}`,
    );
    vi.mocked(fs.readFile).mockResolvedValue(
      `steps:\n  - uses: actions/cache@v4` as any,
    );
    // Only one fetch: resolving the v4 tag. The base SHA short-circuits without a network call.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ sha })),
    );

    const actions = await import("../src/ecosystems/actions.js");
    const deps = await actions.getChangedDeps("HEAD~1", ".github/workflows/cache.yml", "token");
    expect(deps).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("actions.getPublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("queries commit date for SHA refs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ commit: { committer: { date: "2024-01-01T00:00:00Z" } } }),
      ),
    );

    const actions = await import("../src/ecosystems/actions.js");
    const date = await actions.getPublishDate(
      "actions/checkout",
      "a5ac7e51b41094c92402da3b24376905380afc29",
      "token",
    );
    expect(date).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("queries tag date for tag refs", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: { type: "commit", sha: "abc123" } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { committer: { date: "2024-02-01T00:00:00Z" } } })),
      );

    const actions = await import("../src/ecosystems/actions.js");
    const date = await actions.getPublishDate("actions/checkout", "v4", "");
    expect(date).toEqual(new Date("2024-02-01T00:00:00Z"));
  });

  it("returns null for branch refs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const actions = await import("../src/ecosystems/actions.js");
    const date = await actions.getPublishDate("owner/repo", "main", "");
    expect(date).toBeNull();
  });

  it("returns null for invalid name", async () => {
    const actions = await import("../src/ecosystems/actions.js");
    const date = await actions.getPublishDate("invalid", "v1", "");
    expect(date).toBeNull();
  });

  it("handles annotated tag objects", async () => {
    vi.spyOn(globalThis, "fetch")
      // ref/tags lookup returns tag object
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          object: { type: "tag", sha: "tagsha", url: "https://api.github.com/repos/o/r/git/tags/tagsha" },
        })),
      )
      // fetch tag object for tagger date
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tagger: { date: "2024-03-01T00:00:00Z" } })),
      );

    const actions = await import("../src/ecosystems/actions.js");
    const date = await actions.getPublishDate("actions/checkout", "v4", "");
    expect(date).toEqual(new Date("2024-03-01T00:00:00Z"));
  });
});

// ─── kubernetes ecosystem ────────────────────────────────────────────────────

describe("kubernetes.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-detects changed YAML manifests and returns new images", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["k8s/deploy.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(fs.readFile).mockResolvedValue(`
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25@sha256:abc123
` as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps, imageRefs } = await kubernetes.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("docker.io/library/nginx");
    expect(deps[0].version).toBe("1.25@sha256:abc123");
    expect(imageRefs.size).toBe(1);
    expect(imageRefs.has("docker.io/library/nginx@1.25@sha256:abc123")).toBe(true);
  });

  it("skips images present in both HEAD and base (unchanged)", async () => {
    const manifest = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25@sha256:abc123
`;
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["k8s/deploy.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(manifest as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(manifest);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps } = await kubernetes.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(0);
  });

  it("skips non-manifest YAML files (no containers)", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["config.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  key: value
` as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps } = await kubernetes.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(0);
  });

  it("returns empty when no YAML files changed", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["src/main.ts"]);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps } = await kubernetes.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(0);
  });

  it("uses provided kubernetes-files input", async () => {
    vi.mocked(diff.resolveFiles).mockResolvedValue(["rendered/manifests.yaml"]);
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["rendered/manifests.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(`
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: public.ecr.aws/aws-cli/aws-cli:2.34.56@sha256:c6b9b4f1
` as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps } = await kubernetes.getChangedDeps("HEAD~1", "rendered/manifests.yaml");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("public.ecr.aws/aws-cli/aws-cli");
  });

  it("includes tag-only images as deps with version equal to tag", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["k8s/deploy.yaml"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(`
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
` as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const { deps } = await kubernetes.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].version).toBe("16-alpine");
  });
});

describe("kubernetes.getPublishDate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for tag-only ref without calling fetchImagePublishDate", async () => {
    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const date = await kubernetes.getPublishDate({
      raw: "nginx:1.25",
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.25",
      digest: null,
    });
    expect(date).toBeNull();
    expect(vi.mocked(registry.fetchImagePublishDate)).not.toHaveBeenCalled();
  });

  it("delegates to fetchImagePublishDate for digest-pinned refs", async () => {
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValueOnce(
      new Date("2024-03-01T00:00:00Z"),
    );

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const date = await kubernetes.getPublishDate({
      raw: "alpine/psql@sha256:5e2b",
      registry: "docker.io",
      repository: "alpine/psql",
      tag: null,
      digest: "sha256:5e2b",
    });
    expect(date).toEqual(new Date("2024-03-01T00:00:00Z"));
    expect(vi.mocked(registry.fetchImagePublishDate)).toHaveBeenCalledWith(
      "docker.io",
      "alpine/psql",
      "sha256:5e2b",
      null,
    );
  });

  it("passes tag to fetchImagePublishDate when both tag and digest present", async () => {
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValueOnce(
      new Date("2024-05-01T00:00:00Z"),
    );

    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    await kubernetes.getPublishDate({
      raw: "public.ecr.aws/aws-cli/aws-cli:2.34.56@sha256:c6b9b4f1",
      registry: "public.ecr.aws",
      repository: "aws-cli/aws-cli",
      tag: "2.34.56",
      digest: "sha256:c6b9b4f1",
    });
    expect(vi.mocked(registry.fetchImagePublishDate)).toHaveBeenCalledWith(
      "public.ecr.aws",
      "aws-cli/aws-cli",
      "sha256:c6b9b4f1",
      "2.34.56",
    );
  });

  it("returns null for undefined ref", async () => {
    const kubernetes = await import("../src/ecosystems/kubernetes.js");
    const date = await kubernetes.getPublishDate(undefined);
    expect(date).toBeNull();
  });
});

// ─── docker ecosystem ────────────────────────────────────────────────────────

describe("docker.getChangedDeps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-detects changed Dockerfiles and emits FROM refs", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(fs.readFile).mockResolvedValue("FROM nginx:1.25\n" as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const docker = await import("../src/ecosystems/docker.js");
    const { deps, imageRefs } = await docker.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("docker.io/library/nginx");
    expect(imageRefs.size).toBe(1);
  });

  it("COPY --from ref found in registry is emitted as a dep", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(
      "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /src /dst\n" as any,
    );
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(registry.imageExists).mockResolvedValue("found");

    const docker = await import("../src/ecosystems/docker.js");
    const { deps } = await docker.getChangedDeps("HEAD~1", "");
    const names = deps.map((d) => d.name);
    expect(names).toContain("myregistry.io/myimage");
  });

  it("COPY --from ref not found in registry is omitted", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(
      "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /src /dst\n" as any,
    );
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(registry.imageExists).mockResolvedValue("notfound");

    const docker = await import("../src/ecosystems/docker.js");
    const { deps } = await docker.getChangedDeps("HEAD~1", "");
    const names = deps.map((d) => d.name);
    expect(names).not.toContain("myregistry.io/myimage");
    // alpine:3.18 (FROM) is still present
    expect(names).toContain("docker.io/library/alpine");
  });

  it("COPY --from ref returning 'unknown' (private registry, unconfirmed) is skipped", async () => {
    // "unknown" means the registry didn't give a definitive answer (401/429/network
    // error). COPY --from sources are ambiguous (build contexts, stage aliases,
    // real images) so we require a confirmed "found" and drop unconfirmed refs.
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(
      "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /src /dst\n" as any,
    );
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(registry.imageExists).mockResolvedValue("unknown");

    const docker = await import("../src/ecosystems/docker.js");
    const { deps } = await docker.getChangedDeps("HEAD~1", "");
    const names = deps.map((d) => d.name);
    expect(names).not.toContain("myregistry.io/myimage");
    // alpine:3.18 (FROM) is still present — FROM refs are not existence-checked
    expect(names).toContain("docker.io/library/alpine");
  });

  it("FROM ref with digest pin has correct name, version, and imageRefs key", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(
      "FROM nginx:1.25@sha256:abc123\n" as any,
    );
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);

    const docker = await import("../src/ecosystems/docker.js");
    const { deps, imageRefs } = await docker.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("docker.io/library/nginx");
    expect(deps[0].version).toBe("1.25@sha256:abc123");
    expect(imageRefs.has("docker.io/library/nginx@1.25@sha256:abc123")).toBe(true);
  });

  it("unchanged images (present in both HEAD and base) are skipped", async () => {
    const content = "FROM nginx:1.25\n";
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("diff");
    vi.mocked(fs.readFile).mockResolvedValue(content as any);
    vi.mocked(diff.gitShowFile).mockResolvedValue(content);

    const docker = await import("../src/ecosystems/docker.js");
    const { deps } = await docker.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(0);
  });

  it("returns empty when no Dockerfile files changed", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["src/main.ts"]);

    const docker = await import("../src/ecosystems/docker.js");
    const { deps } = await docker.getChangedDeps("HEAD~1", "");
    expect(deps).toHaveLength(0);
  });

  it("passes dockerhubMirror to imageExists for copy-from refs", async () => {
    vi.mocked(diff.gitDiffNameOnly).mockResolvedValue(["Dockerfile"]);
    vi.mocked(diff.gitDiff).mockResolvedValue("some diff");
    vi.mocked(fs.readFile).mockResolvedValue(
      "FROM alpine:3.18\nCOPY --from=myregistry.io/myimage:v1 /app /app\n" as any,
    );
    vi.mocked(diff.gitShowFile).mockResolvedValue(null);
    vi.mocked(registry.imageExists).mockResolvedValue("found");

    const docker = await import("../src/ecosystems/docker.js");
    await docker.getChangedDeps("HEAD~1", "", "mirror.gcr.io");

    expect(vi.mocked(registry.imageExists)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "mirror.gcr.io",
    );
  });
});

describe("docker.getPublishDate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for tag-only ref without calling fetchImagePublishDate", async () => {
    const docker = await import("../src/ecosystems/docker.js");
    const date = await docker.getPublishDate({
      raw: "nginx:1.25",
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.25",
      digest: null,
    });
    expect(date).toBeNull();
    expect(vi.mocked(registry.fetchImagePublishDate)).not.toHaveBeenCalled();
  });

  it("delegates to fetchImagePublishDate for digest-pinned refs", async () => {
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValueOnce(
      new Date("2024-03-01T00:00:00Z"),
    );

    const docker = await import("../src/ecosystems/docker.js");
    const date = await docker.getPublishDate({
      raw: "nginx:1.25@sha256:abc123",
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.25",
      digest: "sha256:abc123",
    });
    expect(date).toEqual(new Date("2024-03-01T00:00:00Z"));
    expect(vi.mocked(registry.fetchImagePublishDate)).toHaveBeenCalledWith(
      "docker.io",
      "library/nginx",
      "sha256:abc123",
      "1.25",
    );
  });

  it("returns null for undefined ref", async () => {
    const docker = await import("../src/ecosystems/docker.js");
    const date = await docker.getPublishDate(undefined);
    expect(date).toBeNull();
    expect(vi.mocked(registry.fetchImagePublishDate)).not.toHaveBeenCalled();
  });
});
