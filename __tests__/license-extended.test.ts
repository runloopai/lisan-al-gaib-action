import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  error: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import * as core from "@actions/core";
import {
  fetchNpmLicense,
  fetchPypiLicense,
  fetchCrateLicense,
  fetchMavenLicense,
  fetchGitHubRepoLicense,
  fetchBcrLicense,
  fetchLicense,
  checkLicenses,
  emitLicenseAnnotations,
} from "../src/license.js";
import type { CheckResult } from "../src/ecosystems/types.js";

const registries = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
  maven: "https://repo1.maven.org/maven2",
};

describe("fetchNpmLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns license from registry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ license: "MIT" })),
    );
    expect(await fetchNpmLicense("pkg", "1.0.0", registries)).toBe("MIT");
  });

  it("returns null on error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"));
    expect(await fetchNpmLicense("pkg", "1.0.0", registries)).toBeNull();
  });

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    expect(await fetchNpmLicense("pkg", "1.0.0", registries)).toBeNull();
  });
});

describe("fetchPypiLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns license from info field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ info: { license: "Apache-2.0" } })),
    );
    expect(await fetchPypiLicense("pkg", "1.0.0", registries)).toBe("Apache-2.0");
  });

  it("falls back to classifiers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          info: {
            license: "UNKNOWN",
            classifiers: ["License :: OSI Approved :: MIT License"],
          },
        }),
      ),
    );
    expect(await fetchPypiLicense("pkg", "1.0.0", registries)).toBe("MIT License");
  });

  it("returns null when no license info", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ info: {} })),
    );
    expect(await fetchPypiLicense("pkg", "1.0.0", registries)).toBeNull();
  });
});

describe("fetchCrateLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns license from crates.io", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: { license: "MIT/Apache-2.0" } })),
    );
    expect(await fetchCrateLicense("serde", "1.0.0", registries)).toBe("MIT/Apache-2.0");
  });

  it("returns null on error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"));
    expect(await fetchCrateLicense("serde", "1.0.0", registries)).toBeNull();
  });
});

describe("fetchMavenLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("extracts license from POM XML", async () => {
    const pom = `<project>
      <licenses>
        <license>
          <name>Apache License, Version 2.0</name>
        </license>
      </licenses>
    </project>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pom, { status: 200 }),
    );
    expect(
      await fetchMavenLicense("com.google:guava", "33.0", [], registries),
    ).toBe("Apache License, Version 2.0");
  });

  it("returns null for invalid name format", async () => {
    expect(await fetchMavenLicense("invalid", "1.0", [], registries)).toBeNull();
  });

  it("returns null when POM has no license", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<project></project>", { status: 200 }),
    );
    expect(
      await fetchMavenLicense("com.example:lib", "1.0", [], registries),
    ).toBeNull();
  });
});

describe("fetchGitHubRepoLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns SPDX ID from GitHub API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ license: { spdx_id: "MIT" } })),
    );
    expect(await fetchGitHubRepoLicense("owner/repo", "token")).toBe("MIT");
  });

  it("returns null for NOASSERTION", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ license: { spdx_id: "NOASSERTION" } })),
    );
    expect(await fetchGitHubRepoLicense("owner/repo", "")).toBeNull();
  });

  it("returns null for invalid name", async () => {
    expect(await fetchGitHubRepoLicense("invalid", "")).toBeNull();
  });
});

describe("fetchBcrLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns first license from metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ licenses: ["Apache-2.0"] })),
    );
    expect(
      await fetchBcrLicense("rules_java", "8.0.0", "https://bcr.bazel.build"),
    ).toBe("Apache-2.0");
  });

  it("returns null when no licenses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({})),
    );
    expect(
      await fetchBcrLicense("mod", "1.0", "https://bcr.bazel.build"),
    ).toBeNull();
  });
});

describe("fetchLicense", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("dispatches to npm fetcher", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ license: "MIT" })),
    );
    const result = await fetchLicense(
      { ecosystem: "npm", name: "pkg", version: "1.0.0" },
      registries,
      new Map(),
      "",
      "",
    );
    expect(result).toBe("MIT");
  });

  it("dispatches to python fetcher", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ info: { license: "BSD-3-Clause" } })),
    );
    const result = await fetchLicense(
      { ecosystem: "python", name: "pkg", version: "1.0.0" },
      registries,
      new Map(),
      "",
      "",
    );
    expect(result).toBe("BSD-3-Clause");
  });

  it("returns null for unknown ecosystem", async () => {
    const result = await fetchLicense(
      { ecosystem: "unknown", name: "pkg", version: "1.0.0" },
      registries,
      new Map(),
      "",
      "",
    );
    expect(result).toBeNull();
  });
});

describe("emitLicenseAnnotations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits error for incompatible licenses", () => {
    const checkResults: CheckResult[] = [
      {
        dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "lock.yaml" },
        publishDate: null,
        ageDays: 30,
        status: "pass",
      },
    ];
    const violations = emitLicenseAnnotations(
      [{ name: "pkg", version: "1.0.0", ecosystem: "npm", license: "GPL-3.0", spdx: "GPL-3.0-only", compatible: false }],
      checkResults,
    );
    expect(violations).toBe(1);
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("incompatible license"),
      expect.objectContaining({ file: "lock.yaml" }),
    );
  });

  it("emits warning for unknown license", () => {
    const violations = emitLicenseAnnotations(
      [{ name: "pkg", version: "1.0.0", ecosystem: "npm", license: null, spdx: null, compatible: null }],
      [{ dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "f" }, publishDate: null, ageDays: 30, status: "pass" }],
    );
    expect(violations).toBe(0);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("could not determine license"),
      expect.anything(),
    );
  });

  it("returns 0 for all compatible", () => {
    const violations = emitLicenseAnnotations(
      [{ name: "pkg", version: "1.0.0", ecosystem: "npm", license: "MIT", spdx: "MIT", compatible: true }],
      [],
    );
    expect(violations).toBe(0);
  });
});

describe("fetchLicense dispatching", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("dispatches to rust fetcher", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: { license: "MIT/Apache-2.0" } })),
    );
    const result = await fetchLicense(
      { ecosystem: "rust", name: "serde", version: "1.0.0" },
      registries, new Map(), "", "",
    );
    expect(result).toBe("MIT/Apache-2.0");
  });

  it("dispatches to java fetcher", async () => {
    const pom = `<project><licenses><license><name>Apache-2.0</name></license></licenses></project>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(pom));
    const result = await fetchLicense(
      { ecosystem: "java", name: "com.google:guava", version: "33.0" },
      registries, new Map([["com.google:guava", ["https://repo1.maven.org/maven2"]]]), "", "",
    );
    expect(result).toBe("Apache-2.0");
  });

  it("dispatches to actions fetcher", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ license: { spdx_id: "MIT" } })),
    );
    const result = await fetchLicense(
      { ecosystem: "actions", name: "actions/checkout", version: "v4" },
      registries, new Map(), "token", "",
    );
    expect(result).toBe("MIT");
  });

  it("dispatches to bazel fetcher", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ licenses: ["Apache-2.0"] })),
    );
    const result = await fetchLicense(
      { ecosystem: "bazel", name: "rules_java", version: "8.0.0" },
      registries, new Map(), "", "https://bcr.bazel.build",
    );
    expect(result).toBe("Apache-2.0");
  });
});

describe("checkLicenses", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("checks all deps and returns results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ license: "MIT" })),
    );
    const results: CheckResult[] = [
      {
        dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "f" },
        publishDate: null,
        ageDays: 30,
        status: "pass",
      },
    ];
    const lr = await checkLicenses(
      results,
      ["MIT"],
      registries,
      new Map(),
      "",
      "",
    );
    expect(lr).toHaveLength(1);
    expect(lr[0].compatible).toBe(true);
  });
});
