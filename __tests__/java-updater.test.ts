/**
 * Tests for Java updater fixes:
 *   1. reconcileJavaConstantGroups: shared-constant cross-artifact validation
 *      (jackson regression — annotations has no 2.21.4, so constant must not be bumped)
 *   2. Existence-gated acceptance in resolveLatest (java case)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

import { reconcileConstantGroups } from "../src/update/reconcile-groups.js";
import { resolveLatest } from "../src/update/latest.js";
import { mavenArtifactExists } from "../src/registry.js";
import type { UpdateCandidate, DepRef } from "../src/update/types.js";
import type { RegistryUrls } from "../src/inputs.js";
import type { JavaArtifactPosition } from "../src/update/ecosystems/java.js";
import type { VersionRef } from "../src/ecosystems/types.js";

const TEST_REGISTRIES = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
  maven: "https://repo1.maven.org/maven2",
};

// Java existence check mirrors run.ts's javaExistenceCheck for the test harness.
const javaExistenceCheck = (
  name: string,
  version: string,
  repos: string[],
  registries: RegistryUrls,
) => {
  const [g, a] = name.split(":");
  if (!g || !a) return Promise.resolve(false);
  return mavenArtifactExists(g, a, version, repos, registries);
};

// This test file only exercises existence-gating behavior (the jackson regression and its
// variants) — P1.2's age-gate is covered separately in update-run.test.ts. Use a permissive
// age check here so existence-passing deps behave exactly as before the age gate was added.
const permissiveJavaAgeCheck = () => Promise.resolve(9999);

/** Thin wrapper matching the reconcileJavaConstantGroups call shape. */
const reconcileJavaConstantGroups = (
  candidates: UpdateCandidate[],
  filteredDeps: DepRef[],
  registries: RegistryUrls,
) =>
  reconcileConstantGroups(
    candidates,
    filteredDeps,
    new Map([["java", javaExistenceCheck]]),
    new Map([["java", permissiveJavaAgeCheck]]),
    registries,
    14,
  );

// Shared constant at file offset 100..105
const SHARED_VREF: VersionRef = {
  value: "2.21",
  nodeStart: 100,
  nodeEnd: 105,
  templatePrefix: "",
  templateSuffix: "",
  constantName: "JACKSON_VERSION",
};

function makeJavaDepRef(opts: {
  name: string;
  current?: string;
  file?: string;
  versionRef?: VersionRef;
  repositories?: string[];
}): DepRef {
  const file = opts.file ?? "/repo/java/MODULE.bazel";
  const versionRef = opts.versionRef ?? SHARED_VREF;
  const pos: JavaArtifactPosition = { file, versionRef };
  return {
    ecosystem: "java",
    name: opts.name,
    file,
    current: opts.current ?? "2.21",
    position: pos,
    repositories: opts.repositories,
  };
}

function makeJavaCandidate(dep: DepRef, latest: string): UpdateCandidate {
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

describe("reconcileJavaConstantGroups", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("drops candidates when a referencing dep has no version (jackson regression)", async () => {
    // jackson-core and jackson-databind have candidates for 2.21.4
    // jackson-annotations has NO candidate and 2.21.4 does NOT exist for it (POM 404)
    const depAnnotations = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-annotations" });
    const depCore = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-core" });
    const depDatabind = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-databind" });

    const filteredDeps: DepRef[] = [depAnnotations, depCore, depDatabind];

    const candidates: UpdateCandidate[] = [
      makeJavaCandidate(depCore, "2.21.4"),
      makeJavaCandidate(depDatabind, "2.21.4"),
      // depAnnotations has no candidate — it never published 2.21.4
    ];

    // annotations POM 404s
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    const warnSpy = vi.mocked(core.warning);
    warnSpy.mockClear();
    await reconcileJavaConstantGroups(candidates, filteredDeps, TEST_REGISTRIES);

    // Both candidates should be dropped
    expect(candidates).toHaveLength(0);
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("JACKSON_VERSION"))).toBe(true);
    expect(warnMessages.some((m) => m.includes("com.fasterxml.jackson.core:jackson-annotations"))).toBe(true);
    expect(warnMessages.some((m) => m.includes("2.21.4"))).toBe(true);
  });

  it("keeps candidates when all referencing deps have a candidate (normal upgrade)", async () => {
    const depCore = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-core" });
    const depDatabind = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-databind" });

    const filteredDeps: DepRef[] = [depCore, depDatabind];
    const candidates: UpdateCandidate[] = [
      makeJavaCandidate(depCore, "2.22.0"),
      makeJavaCandidate(depDatabind, "2.22.0"),
    ];

    // No fetch should be needed (all deps have candidates)
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reconcileJavaConstantGroups(candidates, filteredDeps, TEST_REGISTRIES);

    expect(candidates).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps candidates when a missing dep's version DOES exist", async () => {
    // annotations has no candidate, but 2.21.4 DOES exist for it (POM 200)
    const depAnnotations = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-annotations" });
    const depCore = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-core" });

    const filteredDeps: DepRef[] = [depAnnotations, depCore];
    const candidates: UpdateCandidate[] = [makeJavaCandidate(depCore, "2.21.4")];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await reconcileJavaConstantGroups(candidates, filteredDeps, TEST_REGISTRIES);

    // Candidate should survive — annotations can take 2.21.4
    expect(candidates).toHaveLength(1);
    expect(candidates[0].latest).toBe("2.21.4");
  });

  it("uses dep.repositories when checking existence for missing deps", async () => {
    const customRepo = "https://private.repo/maven2";
    const depAnnotations = makeJavaDepRef({
      name: "com.example:private-lib",
      repositories: [customRepo],
    });
    const depCore = makeJavaDepRef({ name: "com.example:core" });

    const filteredDeps: DepRef[] = [depAnnotations, depCore];
    const candidates: UpdateCandidate[] = [makeJavaCandidate(depCore, "3.0.0")];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    await reconcileJavaConstantGroups(candidates, filteredDeps, TEST_REGISTRIES);

    // Should have tried the custom repo, not maven central
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(customRepo),
      expect.anything(),
    );
    expect(candidates).toHaveLength(0);
  });

  it("does not touch non-java candidates", async () => {
    const depJava = makeJavaDepRef({ name: "com.example:lib" });
    const candidates: UpdateCandidate[] = [makeJavaCandidate(depJava, "2.0.0")];

    // Add a non-java candidate (different ecosystem)
    const npmDep: DepRef = {
      ecosystem: "npm",
      name: "lodash",
      file: "/repo/package.json",
      current: "4.17.20",
      position: {},
    };
    const npmCandidate: UpdateCandidate = {
      dep: npmDep,
      latest: "4.17.21",
      pinnedTo: undefined,
      updateLevel: "patch",
      publishDate: null,
      ageDays: null,
      breaking: false,
      direction: "upgrade",
    };
    candidates.push(npmCandidate);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reconcileJavaConstantGroups(candidates, [depJava, npmDep], TEST_REGISTRIES);

    // npm candidate must survive regardless
    expect(candidates.find((c) => c.dep.ecosystem === "npm")).toBeDefined();
  });

  it("proposes the semver minimum when candidates disagree on version", async () => {
    // Two deps share a constant but resolveLatest returned different versions
    // (core resolved 2.22.0, databind resolved 2.21.4)
    // The constant will be set to 2.21.4 (min). annotations must have 2.21.4.
    const depAnnotations = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-annotations" });
    const depCore = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-core" });
    const depDatabind = makeJavaDepRef({ name: "com.fasterxml.jackson.core:jackson-databind" });

    const filteredDeps: DepRef[] = [depAnnotations, depCore, depDatabind];
    const candidates: UpdateCandidate[] = [
      makeJavaCandidate(depCore, "2.22.0"),
      makeJavaCandidate(depDatabind, "2.21.4"),
    ];

    // Existence check for 2.21.4 against annotations returns 200
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reconcileJavaConstantGroups(candidates, filteredDeps, TEST_REGISTRIES);

    // Candidates survive; the existence check should have used the min version (2.21.4)
    expect(candidates).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/jackson-annotations/2.21.4/"),
      expect.anything(),
    );
  });

  it("is a no-op when there are no Java deps", async () => {
    const npmDep: DepRef = {
      ecosystem: "npm",
      name: "lodash",
      file: "/package.json",
      current: "4.17.20",
      position: {},
    };
    const candidates: UpdateCandidate[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reconcileJavaConstantGroups(candidates, [npmDep], TEST_REGISTRIES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function makeMavenMetadataXml(opts: { versions: string[] }): string {
  const versionTags = opts.versions.map((v) => `    <version>${v}</version>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <versioning>
    <versions>
${versionTags}
    </versions>
  </versioning>
</metadata>`;
}

describe("resolveLatest (java) — existence gate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("skips a metadata-listed version whose POM cannot be resolved", async () => {
    // Simulate: metadata lists 2.21.4 and 2.21.3 (in XML doc order, oldest first).
    // After semver-desc sort, 2.21.4 is tried first — its POM 404s and the Maven
    // Central search also returns nothing → publish date null → skipped.
    // 2.21.3's POM exists and has Last-Modified → accepted.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    vi.spyOn(globalThis, "fetch")
      // 1. mavenMetadataVersions GET
      .mockResolvedValueOnce(
        new Response(makeMavenMetadataXml({ versions: ["2.21.3", "2.21.4"] })),
      )
      // 2. mavenPublishDate("2.21.4"): HEAD POM → 404
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // 3. mavenPublishDate("2.21.4"): search API fallback → empty docs
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ response: { docs: [] } })),
      )
      // 4. mavenPublishDate("2.21.3"): HEAD POM → 200 with Last-Modified
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "Last-Modified": thirtyDaysAgo.toUTCString() },
        }),
      );

    const result = await resolveLatest(
      {
        ecosystem: "java",
        name: "com.fasterxml.jackson.core:jackson-annotations",
        file: "/MODULE.bazel",
        current: "2.21.0",
        position: {},
      },
      {
        mode: "major",
        minAgeDays: 14,
        token: "",
        registries: TEST_REGISTRIES,
        javaRepositories: ["https://repo1.maven.org/maven2"],
      },
    );

    // 2.21.4 must be skipped; 2.21.3 must be the accepted candidate
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].version).toBe("2.21.3");
    expect(result.versions[0].ageDays).toBeGreaterThanOrEqual(29);
  });

  it("returns empty when every metadata-listed version has an unresolvable POM", async () => {
    vi.spyOn(globalThis, "fetch")
      // metadata XML
      .mockResolvedValueOnce(
        new Response(makeMavenMetadataXml({ versions: ["2.21.4"] })),
      )
      // HEAD POM → 404
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // search API → 404
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await resolveLatest(
      {
        ecosystem: "java",
        name: "com.fasterxml.jackson.core:jackson-annotations",
        file: "/MODULE.bazel",
        current: "2.21.0",
        position: {},
      },
      {
        mode: "major",
        minAgeDays: 14,
        token: "",
        registries: TEST_REGISTRIES,
        javaRepositories: ["https://repo1.maven.org/maven2"],
      },
    );

    expect(result.versions).toHaveLength(0);
  });
});
