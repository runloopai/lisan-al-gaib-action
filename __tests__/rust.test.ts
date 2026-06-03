import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

import {
  parseCrateLockVersions,
  resolveCrateVersion,
  cargoReqToNpmRange,
} from "../src/ecosystems/rust.js";

// Minimal lock JSON fixture with the crate_universe extension structure
function makeLock(specs: Record<string, string[]>): string {
  const repoSpecs: Record<string, unknown> = {};
  for (const [name, versions] of Object.entries(specs)) {
    for (const version of versions) {
      repoSpecs[`crates__${name}-${version}`] = {
        attributes: {
          urls: [`https://static.crates.io/crates/${name}/${version}/download`],
        },
      };
    }
  }
  return JSON.stringify({
    moduleExtensions: {
      "@@rules_rust+//crate_universe:extension.bzl%crate": {
        general: {
          generatedRepoSpecs: {
            // umbrella alias repo has no urls — should be skipped silently
            crates: { attributes: { contents: {} } },
            ...repoSpecs,
          },
        },
      },
    },
  });
}

describe("parseCrateLockVersions", () => {
  it("extracts crate name and version from download URLs", () => {
    const content = makeLock({ prost: ["0.13.5"], anyhow: ["1.0.102"] });
    const result = parseCrateLockVersions(content);
    expect(result.get("prost")).toEqual(["0.13.5"]);
    expect(result.get("anyhow")).toEqual(["1.0.102"]);
  });

  it("accumulates multiple versions for the same crate", () => {
    const content = makeLock({ prost: ["0.13.5", "0.14.3"] });
    const result = parseCrateLockVersions(content);
    const versions = result.get("prost");
    expect(versions).toBeDefined();
    expect(versions).toContain("0.13.5");
    expect(versions).toContain("0.14.3");
  });

  it("handles hyphenated crate names (e.g. tokio-util)", () => {
    const content = makeLock({ "tokio-util": ["0.7.18"] });
    const result = parseCrateLockVersions(content);
    expect(result.get("tokio-util")).toEqual(["0.7.18"]);
  });

  it("skips repo specs with no download URL (e.g. umbrella alias repo)", () => {
    const content = makeLock({ prost: ["0.13.5"] });
    const result = parseCrateLockVersions(content);
    // The umbrella "crates" repo in makeLock has no urls — should be absent
    expect(result.has("crates")).toBe(false);
  });

  it("matches extension key with ~ canonical separator variant", () => {
    const content = JSON.stringify({
      moduleExtensions: {
        // Older Bazel used ~ instead of + as the canonical separator
        "@@rules_rust~0.68.0//crate_universe:extension.bzl%crate": {
          general: {
            generatedRepoSpecs: {
              "crates__serde-1.0.200": {
                attributes: {
                  urls: ["https://static.crates.io/crates/serde/1.0.200/download"],
                },
              },
            },
          },
        },
      },
    });
    const result = parseCrateLockVersions(content);
    expect(result.get("serde")).toEqual(["1.0.200"]);
  });

  it("returns empty map for malformed JSON", () => {
    expect(parseCrateLockVersions("not json").size).toBe(0);
  });

  it("returns empty map when moduleExtensions is absent", () => {
    expect(parseCrateLockVersions(JSON.stringify({ lockFileVersion: 11 })).size).toBe(0);
  });

  it("returns empty map when crate_universe extension is absent", () => {
    const content = JSON.stringify({
      moduleExtensions: {
        "@@rules_go+//go:extensions.bzl%go_sdk": {},
      },
    });
    expect(parseCrateLockVersions(content).size).toBe(0);
  });
});

describe("cargoReqToNpmRange", () => {
  it("passes through tilde ranges unchanged", () => {
    expect(cargoReqToNpmRange("~0.13.5")).toBe("~0.13.5");
  });

  it("passes through caret ranges unchanged", () => {
    expect(cargoReqToNpmRange("^1.2.3")).toBe("^1.2.3");
  });

  it("passes through exact = ranges unchanged", () => {
    expect(cargoReqToNpmRange("=1.2.3")).toBe("=1.2.3");
  });

  it("converts bare version to caret (Cargo default semantics)", () => {
    expect(cargoReqToNpmRange("0.13.5")).toBe("^0.13.5");
  });

  it("replaces Cargo comma AND-separator with space", () => {
    expect(cargoReqToNpmRange(">=1.2, <2.0")).toBe(">=1.2  <2.0");
  });

  it("does not add caret to wildcard ranges", () => {
    expect(cargoReqToNpmRange("1.2.*")).toBe("1.2.*");
  });
});

describe("resolveCrateVersion", () => {
  it("returns the single version when only one exists in the lock", () => {
    const lock = new Map([["prost", ["0.13.5"]]]);
    expect(resolveCrateVersion("prost", "~0.13.5", lock)).toBe("0.13.5");
  });

  it("disambiguates using tilde range when multiple versions exist", () => {
    const lock = new Map([["prost", ["0.13.5", "0.14.3"]]]);
    expect(resolveCrateVersion("prost", "~0.13.5", lock)).toBe("0.13.5");
  });

  it("picks the higher in-range version when available", () => {
    const lock = new Map([["tokio", ["1.52.0", "1.52.3"]]]);
    expect(resolveCrateVersion("tokio", "~1.52", lock)).toBe("1.52.3");
  });

  it("falls back to raw range when crate is absent from the lock", () => {
    const lock = new Map<string, string[]>();
    expect(resolveCrateVersion("unknown-crate", "~0.1.0", lock)).toBe("~0.1.0");
  });

  it("falls back to raw range when no semver match among multiple versions", () => {
    const lock = new Map([["foo", ["2.0.0", "3.0.0"]]]);
    expect(resolveCrateVersion("foo", "~1.0.0", lock)).toBe("~1.0.0");
  });

  it("falls back to raw range when single lock version does not satisfy the range (stale lock)", () => {
    // Developer changed crate.spec ~1.0 → ~2.0 but forgot to regenerate the lock.
    // The lock still only has 1.5.3; returning it would silently report the wrong age.
    const lock = new Map([["foo", ["1.5.3"]]]);
    expect(resolveCrateVersion("foo", "~2.0.0", lock)).toBe("~2.0.0");
  });

  it("resolves exact = range to the locked version", () => {
    const lock = new Map([["vm-memory", ["0.17.1"]]]);
    expect(resolveCrateVersion("vm-memory", "=0.17.1", lock)).toBe("0.17.1");
  });

  it("resolves bare version (Cargo caret) to the locked version", () => {
    const lock = new Map([["libc", ["0.2.186"]]]);
    expect(resolveCrateVersion("libc", "0.2.186", lock)).toBe("0.2.186");
  });
});
