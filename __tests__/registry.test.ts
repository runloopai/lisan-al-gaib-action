import { describe, it, expect, vi, beforeEach } from "vitest";
import { XMLParser } from "fast-xml-parser";
import semver from "semver";

const coreMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@actions/core", () => coreMock);

import {
  npmPublishDate,
  npmVersions,
  pypiPublishDate,
  cratesPublishDate,
  cratesVersions,
  mavenPublishDate,
  mavenArtifactExists,
  mavenMetadataVersions,
  gitCommitDate,
  archiveDate,
  fetchImagePublishDate,
  fetchImageLabels,
  imageExists,
  bcrPublishDate,
  bcrVersions,
  ociDigestForTag,
  githubApiFetch,
  _resetGitHubWarningFlags,
  compareVersionsDesc,
  sanePublishDate,
} from "../src/registry.js";

const registries = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
  maven: "https://repo1.maven.org/maven2",
};

describe("npmPublishDate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns date from registry response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          time: { "1.0.0": "2024-01-15T00:00:00.000Z" },
          versions: { "1.0.0": {} },
        }),
      ),
    );
    const date = await npmPublishDate("pkg", "1.0.0", registries);
    expect(date).toEqual(new Date("2024-01-15T00:00:00.000Z"));
  });

  it("returns null for missing version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ time: {} })),
    );
    expect(await npmPublishDate("pkg", "9.9.9", registries)).toBeNull();
  });

  it("returns null on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    expect(await npmPublishDate("pkg", "1.0.0", registries)).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    expect(await npmPublishDate("pkg", "1.0.0", registries)).toBeNull();
  });
});

describe("pypiPublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns date from PyPI response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          urls: [{ upload_time_iso_8601: "2024-03-01T12:00:00Z" }],
        }),
      ),
    );
    const date = await pypiPublishDate("requests", "2.31.0", registries);
    expect(date).toEqual(new Date("2024-03-01T12:00:00Z"));
  });

  it("returns null when urls array is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ urls: [] })),
    );
    expect(await pypiPublishDate("pkg", "1.0.0", registries)).toBeNull();
  });

  it("returns null on error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"));
    expect(await pypiPublishDate("pkg", "1.0.0", registries)).toBeNull();
  });
});

describe("cratesPublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns date for matching version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          versions: [
            { num: "0.1.0", created_at: "2023-01-01T00:00:00Z" },
            { num: "0.2.0", created_at: "2024-06-01T00:00:00Z" },
          ],
        }),
      ),
    );
    const date = await cratesPublishDate("serde", "0.2.0", registries);
    expect(date).toEqual(new Date("2024-06-01T00:00:00Z"));
  });

  it("returns null when version not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ versions: [{ num: "0.1.0" }] })),
    );
    expect(await cratesPublishDate("serde", "9.9.9", registries)).toBeNull();
  });
});

describe("mavenPublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns date from Last-Modified header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "Last-Modified": "Wed, 01 Jan 2024 00:00:00 GMT" },
      }),
    );
    const date = await mavenPublishDate(
      "com.google.guava",
      "guava",
      "33.0.0",
      ["https://repo1.maven.org/maven2"],
      registries,
    );
    expect(date).toEqual(new Date("Wed, 01 Jan 2024 00:00:00 GMT"));
  });

  it("falls back to search API when HEAD has no Last-Modified", async () => {
    // HEAD request with no Last-Modified
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // Search API
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: { docs: [{ timestamp: 1704067200000 }] },
          }),
        ),
      )
      // mavenArtifactExists POM HEAD check (M5: verify artifact exists before trusting search timestamp)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const date = await mavenPublishDate(
      "com.google",
      "artifact",
      "1.0.0",
      ["https://repo1.maven.org/maven2"],
      registries,
    );
    expect(date).toEqual(new Date(1704067200000));
  });

  it("returns null when everything fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    expect(
      await mavenPublishDate("g", "a", "1.0", [], registries),
    ).toBeNull();
  });

  it("resolves Maven Central URLs to configured registry", async () => {
    const customRegistries = { ...registries, maven: "https://custom.maven.org" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "Last-Modified": "Wed, 01 Jan 2024 00:00:00 GMT" },
      }),
    );
    await mavenPublishDate(
      "com.example",
      "lib",
      "1.0.0",
      ["https://repo.maven.apache.org/maven2"],
      customRegistries,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://custom.maven.org/"),
      expect.anything(),
    );
  });

  it("throws on transient 5xx (fail-closed: resolveLazy catch..break engages)", async () => {
    // A 5xx response is retried up to maxRetries by fetchHeadWithRetry, then returns
    // { kind: "error" }, which mavenPublishDate re-throws. Callers (resolveLazy) can
    // then break out of version iteration rather than silently skipping to an older version.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      mavenPublishDate("com.google", "guava", "33.0.0", ["https://repo1.maven.org/maven2"], registries),
    ).rejects.toThrow("Maven POM unreachable");
  });

  it("returns null when all repos return 404 (genuinely absent)", async () => {
    // All repos returning 404 means the POM is genuinely not present; no throw.
    vi.spyOn(globalThis, "fetch")
      // HEAD on each repo → 404
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // Central search API → empty docs (no match in index either)
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: { docs: [] } })));
    const date = await mavenPublishDate(
      "com.example", "missing", "0.0.1",
      ["https://repo1.maven.org/maven2", "https://repo.maven.apache.org/maven2"],
      registries,
    );
    expect(date).toBeNull();
  });

  it("throws when first repo returns 5xx even though second repo is healthy", async () => {
    // Conservative fail-closed: any transient error on any repo triggers a throw
    // immediately rather than silently falling through to the next repo.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      mavenPublishDate(
        "com.example", "lib", "1.0.0",
        ["https://private.repo/maven2", "https://repo1.maven.org/maven2"],
        registries,
      ),
    ).rejects.toThrow("Maven POM unreachable");
  });
});

describe("gitCommitDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns date from GitHub API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          commit: { committer: { date: "2024-01-01T00:00:00Z" } },
        }),
      ),
    );
    const date = await gitCommitDate(
      "https://github.com/owner/repo",
      "abc123",
      "token",
    );
    expect(date).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("returns null for non-GitHub URL", async () => {
    expect(
      await gitCommitDate("https://gitlab.com/owner/repo", "abc", ""),
    ).toBeNull();
  });

  it("handles SSH URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          commit: { committer: { date: "2024-01-01T00:00:00Z" } },
        }),
      ),
    );
    const date = await gitCommitDate(
      "git@github.com:owner/repo.git",
      "abc123",
      "",
    );
    expect(date).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("returns null on API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    expect(
      await gitCommitDate("https://github.com/o/r", "ref", ""),
    ).toBeNull();
  });
});

describe("githubApiFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetGitHubWarningFlags();
    coreMock.warning.mockClear();
  });

  it("returns ok result with parsed JSON on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ sha: "abc" })),
    );
    const result = await githubApiFetch("https://api.github.com/repos/o/r/commits/main", "tok");
    expect(result).toEqual({ kind: "ok", data: { sha: "abc" } });
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  it("returns rate_limited and emits warning once on 403 with X-RateLimit-Remaining: 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "9999999999" },
      }),
    );
    const r1 = await githubApiFetch("https://api.github.com/repos/o/r", "");
    const r2 = await githubApiFetch("https://api.github.com/repos/o/r", "");
    expect(r1.kind).toBe("rate_limited");
    expect(r2.kind).toBe("rate_limited");
    // Warning emitted only once
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/rate limit exceeded/i);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/GITHUB_TOKEN/);
  });

  it("rate_limited warning omits GITHUB_TOKEN hint when token is already set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      }),
    );
    await githubApiFetch("https://api.github.com/repos/o/r", "mytoken");
    expect(coreMock.warning.mock.calls[0][0]).not.toMatch(/Set GITHUB_TOKEN/);
  });

  it("returns unauthorized and emits warning once on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const r1 = await githubApiFetch("https://api.github.com/repos/o/r", "bad-token");
    const r2 = await githubApiFetch("https://api.github.com/repos/o/r", "bad-token");
    expect(r1.kind).toBe("unauthorized");
    expect(r2.kind).toBe("unauthorized");
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/401 Unauthorized/);
  });

  it("returns not_found on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const result = await githubApiFetch("https://api.github.com/repos/o/r/commits/missing", "tok");
    expect(result.kind).toBe("not_found");
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    const result = await githubApiFetch("https://api.github.com/repos/o/r", "tok");
    expect(result.kind).toBe("error");
  });
});

describe("bcrPublishDate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetGitHubWarningFlags();
    coreMock.warning.mockClear();
  });

  it("returns date from GitHub commits API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { commit: { committer: { date: "2024-05-01T00:00:00Z" } } },
        ]),
      ),
    );
    const date = await bcrPublishDate("rules_java", "8.0.0", "token", "https://bcr.bazel.build");
    expect(date).toEqual(new Date("2024-05-01T00:00:00Z"));
  });

  it("falls back to source.json archive with Last-Modified for non-GitHub archive URLs", async () => {
    vi.spyOn(globalThis, "fetch")
      // GitHub commits API returns empty
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // source.json
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://example.com/archive.tar.gz" })),
      )
      // HEAD on non-GitHub archive URL
      .mockResolvedValueOnce(
        new Response(null, { headers: { "Last-Modified": "Fri, 01 Mar 2024 00:00:00 GMT" } }),
      );
    const date = await bcrPublishDate("mod", "1.0", "", "https://bcr.bazel.build");
    expect(date).toEqual(new Date("Fri, 01 Mar 2024 00:00:00 GMT"));
  });

  it("falls back to source.json GitHub archive via tag commit API (no Last-Modified on GitHub zips)", async () => {
    vi.spyOn(globalThis, "fetch")
      // GitHub commits API (strategy 1) returns empty
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // source.json
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ url: "https://github.com/protocolbuffers/protobuf/archive/refs/tags/v3.19.6.zip" }),
        ),
      )
      // GitHub tag/commit API (strategy 2 for GitHub archive)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ commit: { committer: { date: "2022-10-11T15:44:50Z" } } }),
        ),
      );
    const date = await bcrPublishDate("protobuf", "3.19.6", "token", "https://bcr.bazel.build");
    expect(date).toEqual(new Date("2022-10-11T15:44:50Z"));
  });

  it("emits actionable warning when commits API is rate-limited", async () => {
    vi.spyOn(globalThis, "fetch")
      // Commits API → 403 rate-limited
      .mockResolvedValueOnce(
        new Response(null, { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
      )
      // source.json fetch also fails
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const date = await bcrPublishDate("protobuf", "3.19.6", "", "https://bcr.bazel.build");
    expect(date).toBeNull();
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/rate limit exceeded/i);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/GITHUB_TOKEN/);
  });

  it("returns null when everything fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect(await bcrPublishDate("mod", "1.0", "", "https://bcr.bazel.build")).toBeNull();
  });

  it("extracts BCR owner/repo from GitHub URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { commit: { committer: { date: "2024-01-01T00:00:00Z" } } },
        ]),
      ),
    );
    await bcrPublishDate("mod", "1.0", "", "https://github.com/my-org/my-bcr");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("my-org/my-bcr"),
      expect.anything(),
    );
  });
});

// P2.1: bcrVersions previously returned [] for ANY non-ok metadata fetch (not_found,
// rate_limited, or error alike) with no warning, so a rate-limited/unreachable BCR was
// indistinguishable from "module genuinely has no versions" — reported to the user as
// "up to date" when it was never actually checked.
describe("bcrVersions — transient-failure visibility (P2.1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    coreMock.warning.mockClear();
  });

  it("warns and returns [] when the metadata fetch is persistently rate-limited (429)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 429 }));
    const versions = await bcrVersions("rules_java", "token", "https://bcr.bazel.build");
    expect(versions).toEqual([]);
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/rules_java/);
  }, 10_000);

  it("returns [] without warning when BCR genuinely has no metadata for the module (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const versions = await bcrVersions("nonexistent_module", "token", "https://bcr.bazel.build");
    expect(versions).toEqual([]);
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  // P2.3: promotion-oracle adversarial coverage — branch-style version strings ("main",
  // "latest-snapshot") that don't coerce to semver must not crash the sort or pollute the
  // candidate list; date-style versions that DO coerce must survive.
  it("filters out non-coercible branch-style versions while keeping date-style ones", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ versions: ["main", "1.2.0", "latest-snapshot", "1.1.0"] }),
        ),
      )
      // bcrPublishDate lookup for the latest ("1.2.0"): GitHub commits API → empty
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // source.json fallback also fails
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const versions = await bcrVersions("my_module", "", "https://bcr.bazel.build");
    expect(versions.map((v) => v.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  // Filter/comparator predicate mismatch: `semver.coerce()` returns non-null for a
  // version with an overflowing numeric segment (>Number.MAX_SAFE_INTEGER), e.g.
  // "99999999999999999.0" coerces to "0.0.0" — silently losing precision. A bare
  // `semver.coerce(v) !== null` filter would let it through, while
  // compareVersionsDesc(..., true) treats it as non-comparable and sorts it last.
  // The filter must use the same predicate as the comparator so a fuzzed/malformed
  // BCR metadata.json entry can never be mis-selected as "latest".
  it("excludes an overflowing-segment version from the filter and ranks it last, never as latest", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            versions: ["99999999999999999.0", "1.2.0", "1.1.0"],
          }),
        ),
      )
      // bcrPublishDate lookup for the latest ("1.2.0"): GitHub commits API → empty
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // source.json fallback also fails
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const versions = await bcrVersions("my_module", "", "https://bcr.bazel.build");
    expect(versions.map((v) => v.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(versions.map((v) => v.version)).not.toContain("99999999999999999.0");
  });

  it("still picks a valid latest when only an overflowing-segment version sorts first lexically", async () => {
    // "99999999999999999.0" would sort before "1.2.0" and "1.1.0" in raw lexical
    // ordering (starts with "9"), so this specifically guards against a naive
    // filter/sort combination picking it as sorted[0] ("latest").
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            versions: ["1.1.0", "99999999999999999.0", "1.2.0"],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const versions = await bcrVersions("my_module", "", "https://bcr.bazel.build");
    expect(versions[0]?.version).toBe("1.2.0");
    expect(versions.map((v) => v.version)).not.toContain("99999999999999999.0");
  });
});

// P2.3: promotion-oracle adversarial coverage for npmVersions's slimmed-packument
// trust boundary — a private/mirror registry that omits the `versions` map.
describe("npmVersions — promotion oracle adversarial cases (P2.3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    coreMock.warning.mockClear();
    // The "missing versions field" warning is one-time-per-registry-host; reset it so
    // earlier tests in this file (e.g. npmPublishDate's "returns null for missing version",
    // which also omits `versions`) don't suppress the warning here.
    _resetGitHubWarningFlags();
  });

  it("trusts the time map (with a warning) when versions is absent, restricted to valid semver entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          time: {
            created: "2020-01-01T00:00:00Z",
            modified: "2024-01-01T00:00:00Z",
            "1.0.0": "2021-01-01T00:00:00Z",
            "2.0.0-rc.1": "2024-06-01T00:00:00Z", // valid semver prerelease — kept (only non-semver junk is excluded)
            "not-a-version": "2024-06-01T00:00:00Z", // junk key — must be excluded
          },
          // no `versions` field — slimmed packument
        }),
      ),
    );
    const versions = await npmVersions("some-pkg", registries);
    expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "2.0.0-rc.1"]);
    expect(coreMock.warning).toHaveBeenCalledWith(expect.stringContaining("without a \"versions\" field"));
  });

  it("does not warn when the full packument (with a versions map) is returned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          time: { "1.0.0": "2021-01-01T00:00:00Z" },
          versions: { "1.0.0": {} },
        }),
      ),
    );
    const versions = await npmVersions("some-pkg", registries);
    expect(versions.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  it("throws (fail-closed) on a 200 response with a malformed JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not valid json"));
    await expect(npmVersions("some-pkg", registries)).rejects.toThrow();
  });
});

// P2.3: promotion-oracle adversarial coverage for cratesVersions.
describe("cratesVersions — promotion oracle adversarial cases (P2.3)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns [] when every version of the crate has been yanked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          versions: [
            { num: "1.0.0", created_at: "2021-01-01T00:00:00Z", yanked: true },
            { num: "0.9.0", created_at: "2020-01-01T00:00:00Z", yanked: true },
          ],
        }),
      ),
    );
    const versions = await cratesVersions("some-crate", registries);
    expect(versions).toEqual([]);
  });
});

// P2.3: promotion-oracle adversarial coverage for ociDigestForTag — a malformed
// Docker-Content-Digest header from a hostile/misconfigured registry must never be
// trusted as a real digest (would otherwise let an attacker pin to an invalid value).
describe("ociDigestForTag — malformed digest header (P2.3)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns null when the registry returns a malformed Docker-Content-Digest header", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping /v2/ — no auth needed
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "Docker-Content-Digest": "not-a-real-digest" } }),
      );
    const digest = await ociDigestForTag("registry-1.docker.io", "library/nginx", "latest");
    expect(digest).toBeNull();
  });

  it("returns the digest when it matches the expected sha256 format", async () => {
    const validDigest = `sha256:${"a".repeat(64)}`;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping /v2/ — no auth needed
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "Docker-Content-Digest": validDigest } }),
      );
    const digest = await ociDigestForTag("registry-1.docker.io", "library/nginx", "latest");
    expect(digest).toBe(validDigest);
  });
});

describe("archiveDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns Last-Modified date", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        headers: { "Last-Modified": "Thu, 01 Feb 2024 00:00:00 GMT" },
      }),
    );
    const date = await archiveDate("https://example.com/archive.tar.gz");
    expect(date).toEqual(new Date("Thu, 01 Feb 2024 00:00:00 GMT"));
  });

  it("returns null when no Last-Modified header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null));
    expect(await archiveDate("https://example.com/archive.tar.gz")).toBeNull();
  });

  it("returns null on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"));
    expect(await archiveDate("https://example.com/archive.tar.gz")).toBeNull();
  });
});

describe("fetch timeout", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("passes AbortSignal.timeout to fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ time: { "1.0.0": "2024-01-01T00:00:00Z" } })),
    );
    await npmPublishDate("pkg", "1.0.0", registries);
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[1]).toHaveProperty("signal");
  });

  it("returns null on timeout (AbortError)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    expect(await npmPublishDate("pkg", "1.0.0", registries)).toBeNull();
  });
});

describe("fetchImagePublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses Docker Hub Hub API tag_last_pushed when tag is provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ name: "3.20", tag_last_pushed: "2024-05-01T00:00:00Z" }],
        }),
      ),
    );
    const date = await fetchImagePublishDate(
      "docker.io",
      "library/alpine",
      "sha256:abc123",
      "3.20",
    );
    expect(date).toEqual(new Date("2024-05-01T00:00:00Z"));
  });

  it("uses Last-Modified header from manifest for non-Docker Hub registries", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 401
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://auth.example.com/token",service="example.com"',
          },
        }),
      )
      // token
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok123" })))
      // manifest with Last-Modified
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "last-modified": "Mon, 01 Jan 2024 12:00:00 GMT",
          },
        }),
      );
    const date = await fetchImagePublishDate(
      "registry.k8s.io",
      "pause",
      "sha256:abc",
      null,
    );
    expect(date).toEqual(new Date("Mon, 01 Jan 2024 12:00:00 GMT"));
  });

  it("falls back to Last-Modified when Docker Hub Hub API returns no match", async () => {
    vi.spyOn(globalThis, "fetch")
      // Hub API → empty results
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      // ping → 401
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        }),
      )
      // token
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok" })))
      // manifest with Last-Modified
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "last-modified": "Wed, 15 Mar 2024 00:00:00 GMT",
          },
        }),
      );
    const date = await fetchImagePublishDate(
      "docker.io",
      "library/nginx",
      "sha256:def",
      "1.25",
    );
    expect(date).toEqual(new Date("Wed, 15 Mar 2024 00:00:00 GMT"));
  });

  it("drills into linux/amd64 child for OCI image index", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 401
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://auth.example.com/token",service="example.com"',
          },
        }),
      )
      // token
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok" })))
      // index manifest
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
              { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
            ],
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // linux/amd64 child manifest with Last-Modified
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "last-modified": "Tue, 20 Feb 2024 00:00:00 GMT",
          },
        }),
      );
    const date = await fetchImagePublishDate(
      "public.ecr.aws",
      "docker/library/alpine",
      "sha256:idx",
      null,
    );
    expect(date).toEqual(new Date("Tue, 20 Feb 2024 00:00:00 GMT"));
  });

  it("returns null when private registry rejects anonymous token fetch", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 401
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://private.ecr.aws/token",service="priv"',
          },
        }),
      )
      // token endpoint → 401 (private, credentials required)
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // manifest → 401 (no valid token)
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const date = await fetchImagePublishDate(
      "992382648534.dkr.ecr.us-east-2.amazonaws.com",
      "mux_repo",
      "sha256:priv",
      null,
    );
    expect(date).toBeNull();
  });

  it("returns null when manifest has no Last-Modified header", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 200 (no auth needed)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // manifest with no Last-Modified
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
        }),
      );
    const date = await fetchImagePublishDate(
      "registry.k8s.io",
      "pause",
      "sha256:xyz",
      null,
    );
    expect(date).toBeNull();
  });

  it("returns null when OCI index has empty manifests array", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping → no auth
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ manifests: [] }), {
          headers: { "content-type": "application/vnd.oci.image.index.v1+json" },
        }),
      );
    const date = await fetchImagePublishDate(
      "registry.k8s.io",
      "pause",
      "sha256:idx",
      null,
    );
    expect(date).toBeNull();
  });

  it("falls back to first child when no linux/amd64 child in OCI index", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping → no auth
      // index: only arm64 available
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
            ],
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // first child manifest
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "last-modified": "Fri, 01 Mar 2024 00:00:00 GMT",
          },
        }),
      );
    const date = await fetchImagePublishDate(
      "registry.k8s.io",
      "pause",
      "sha256:idx",
      null,
    );
    expect(date).toEqual(new Date("Fri, 01 Mar 2024 00:00:00 GMT"));
  });

  it("returns null on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const date = await fetchImagePublishDate(
      "ghcr.io",
      "owner/image",
      "sha256:abc",
      null,
    );
    expect(date).toBeNull();
  });
});

describe("fetchImageLabels", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns Labels from a single-arch manifest (no-auth registry)", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 200 (no auth needed)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // manifest
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { digest: "sha256:cfg123" } }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      // config blob
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              Labels: {
                "org.opencontainers.image.licenses": "Apache-2.0",
                "org.opencontainers.image.source": "https://github.com/owner/repo",
              },
            },
          }),
        ),
      );
    const labels = await fetchImageLabels("quay.io", "owner/image", "sha256:abc");
    expect(labels).toEqual({
      "org.opencontainers.image.licenses": "Apache-2.0",
      "org.opencontainers.image.source": "https://github.com/owner/repo",
    });
  });

  it("drills into the linux/amd64 child of an image index", async () => {
    vi.spyOn(globalThis, "fetch")
      // ping → 401 + token
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="example.com"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok" })))
      // index manifest
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
              { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
            ],
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // child manifest (amd64)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { digest: "sha256:cfg" } }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      // config blob
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { Labels: { "org.opencontainers.image.licenses": "MIT" } } }),
        ),
      );
    const labels = await fetchImageLabels("registry.example.com", "owner/image", "sha256:index");
    expect(labels?.["org.opencontainers.image.licenses"]).toBe("MIT");
  });

  it("returns null when the manifest has no config.digest", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ layers: [] }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels).toBeNull();
  });

  it("returns null on private-registry 401 (anonymous token rejected)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://private.example.com/token",service="private"' },
        }),
      )
      // token endpoint returns 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const labels = await fetchImageLabels("private.example.com", "org/image", "sha256:abc");
    expect(labels).toBeNull();
  });

  it("returns null when the config blob has no Labels", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { digest: "sha256:cfg" } }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ config: {} })),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels).toBeNull();
  });

  it("returns null when the config blob fetch returns a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { digest: "sha256:cfg" } }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels).toBeNull();
  });

  it("returns manifest annotations when config.Labels is absent", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // manifest with top-level annotations but no config Labels
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { digest: "sha256:cfg" },
            annotations: { "org.opencontainers.image.licenses": "MIT" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      // config blob has no Labels
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ config: {} })),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels).toEqual({ "org.opencontainers.image.licenses": "MIT" });
  });

  it("returns null when no config digest and no annotations", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ layers: [] }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels).toBeNull();
  });

  it("config.Labels take precedence over manifest annotations on key conflict", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { digest: "sha256:cfg" },
            annotations: { "org.opencontainers.image.licenses": "Apache-2.0" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
      // config blob overrides with MIT
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { Labels: { "org.opencontainers.image.licenses": "MIT" } } }),
        ),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:abc");
    expect(labels?.["org.opencontainers.image.licenses"]).toBe("MIT");
  });

  it("merges index annotations, child-descriptor annotations, and child manifest annotations", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // image index with top-level annotations and per-descriptor annotations
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              {
                digest: "sha256:amd",
                platform: { os: "linux", architecture: "amd64" },
                annotations: { "org.opencontainers.image.revision": "abc123" },
              },
            ],
            annotations: { "org.opencontainers.image.vendor": "Acme" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // child manifest has its own annotations, no config digest
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            annotations: { "org.opencontainers.image.licenses": "Apache-2.0" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      )
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:index");
    expect(labels).toEqual({
      "org.opencontainers.image.vendor": "Acme",
      "org.opencontainers.image.revision": "abc123",
      "org.opencontainers.image.licenses": "Apache-2.0",
    });
  });

  it("child manifest annotations override child-descriptor and index annotations on same key", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // index: licenses=IndexValue at top level, child descriptor also sets licenses=DescriptorValue
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              {
                digest: "sha256:amd",
                platform: { os: "linux", architecture: "amd64" },
                annotations: { "org.opencontainers.image.licenses": "DescriptorValue" },
              },
            ],
            annotations: { "org.opencontainers.image.licenses": "IndexValue" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // child manifest: licenses=ManifestValue (should win)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            annotations: { "org.opencontainers.image.licenses": "ManifestValue" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
        ),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:index");
    expect(labels?.["org.opencontainers.image.licenses"]).toBe("ManifestValue");
  });

  it("returns index annotations even when the index manifests array is empty", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [],
            annotations: { "org.opencontainers.image.licenses": "MIT" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      );
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:index");
    expect(labels).toEqual({ "org.opencontainers.image.licenses": "MIT" });
  });

  it("returns index annotations when child manifest fetch fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // index with license annotation
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
            ],
            annotations: { "org.opencontainers.image.licenses": "MIT" },
          }),
          { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } },
        ),
      )
      // child manifest fetch fails
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const labels = await fetchImageLabels("ghcr.io", "owner/image", "sha256:index");
    expect(labels).toEqual({ "org.opencontainers.image.licenses": "MIT" });
  });
});

describe("imageExists", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 'found' on HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping /v2/
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // HEAD manifest
    const result = await imageExists("docker.io", "library/nginx", "latest");
    expect(result).toBe("found");
  });

  it("returns 'notfound' on HTTP 404", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping
      .mockResolvedValueOnce(new Response(null, { status: 404 })); // HEAD manifest
    const result = await imageExists("docker.io", "library/nginx", "latest");
    expect(result).toBe("notfound");
  });

  // P2: imageExistsOnHost now routes its manifest HEAD through fetchHeadWithRetry, so a 429
  // is retried (default maxRetries=3 → 4 attempts total) before the result is classified as
  // "unknown" — a transient rate-limit is no longer indistinguishable from "tag absent".
  it("returns 'unknown' on HTTP 429 (rate-limited, retries exhausted)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping
      .mockResolvedValue(new Response(null, { status: 429 })); // HEAD manifest — every attempt
    const result = await imageExists("docker.io", "library/nginx", "latest");
    expect(result).toBe("unknown");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(5); // 1 ping + 4 HEAD attempts
  }, 10_000);

  it("falls back to mirror when docker.io's retries are exhausted and mirror is configured", async () => {
    vi.spyOn(globalThis, "fetch")
      // Primary: ping registry-1.docker.io + HEAD returns 429 on every retry attempt
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      // Mirror: ping mirror.gcr.io + HEAD returns 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await imageExists("docker.io", "library/nginx", "latest", "mirror.gcr.io");
    expect(result).toBe("found");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(7);
  }, 10_000);

  it("returns mirror 'notfound' when docker.io's retries are exhausted but mirror says 404", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await imageExists("docker.io", "library/builder-tools", "latest", "mirror.gcr.io");
    expect(result).toBe("notfound");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(7);
  }, 10_000);

  it("does not use mirror when registry is not docker.io", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // ping ghcr.io
      .mockResolvedValue(new Response(null, { status: 429 })); // HEAD returns unknown after retries
    const result = await imageExists("ghcr.io", "org/image", "latest", "mirror.gcr.io");
    // mirror should NOT be tried for non-docker.io registries
    expect(result).toBe("unknown");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(5); // 1 ping + 4 HEAD attempts
  }, 10_000);

  it("retries a 429 with backoff but does not fall through to a mirror when none is configured", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 429 }));
    const result = await imageExists("docker.io", "library/nginx", "latest");
    expect(result).toBe("unknown");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(5); // 1 ping + 4 HEAD attempts
  }, 10_000);
});

describe("mavenArtifactExists", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns true when POM responds with HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );
    expect(
      await mavenArtifactExists("com.example", "lib", "1.0.0", ["https://repo1.maven.org/maven2"], registries),
    ).toBe(true);
  });

  it("returns false when POM responds with HTTP 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    expect(
      await mavenArtifactExists("com.example", "lib", "9.9.9", ["https://repo1.maven.org/maven2"], registries),
    ).toBe(false);
  });

  it("returns true if first repo fails but second repo has the POM", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(
      await mavenArtifactExists(
        "com.example", "lib", "1.0.0",
        ["https://private.repo/maven2", "https://repo1.maven.org/maven2"],
        registries,
      ),
    ).toBe(true);
  });

  it("returns false when all repos fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect(
      await mavenArtifactExists("com.example", "lib", "1.0.0", ["https://repo1.maven.org/maven2"], registries),
    ).toBe(false);
  });

  it("throws on network error (fail-closed: transient failures surface as errors)", async () => {
    // Network errors exhaust maxNetworkRetries=1 then return { kind: "error" } from
    // fetchHeadWithRetry, which mavenArtifactExists re-throws so callers distinguish
    // "confirmed absent" from "unreachable".
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"));
    await expect(
      mavenArtifactExists("com.example", "lib", "1.0.0", ["https://repo1.maven.org/maven2"], registries),
    ).rejects.toThrow("Maven POM unreachable");
  });

  it("throws on 5xx (fail-closed: transient 5xx is indistinguishable from infrastructure failure)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      mavenArtifactExists("com.example", "lib", "1.0.0", ["https://repo1.maven.org/maven2"], registries),
    ).rejects.toThrow("Maven POM unreachable");
  });

  it("returns false when all repos respond with 404 (genuinely absent)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect(
      await mavenArtifactExists(
        "com.example", "lib", "9.9.9",
        ["https://repo1.maven.org/maven2", "https://repo2.example.com/maven2"],
        registries,
      ),
    ).toBe(false);
  });
});

function makeMavenMetadataXml(opts: {
  latest?: string;
  versions: string[];
}): string {
  const versionTags = opts.versions.map((v) => `    <version>${v}</version>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <versioning>
    ${opts.latest ? `<latest>${opts.latest}</latest>` : ""}
    <versions>
${versionTags}
    </versions>
  </versioning>
</metadata>`;
}

describe("mavenMetadataVersions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns versions sorted semver-desc", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(makeMavenMetadataXml({ versions: ["1.0.0", "2.0.0", "1.5.0"] })),
    );
    const result = await mavenMetadataVersions("com.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    expect(result.map((r) => r.version)).toEqual(["2.0.0", "1.5.0", "1.0.0"]);
  });

  it("returns all entries with publishDate null (no Last-Modified attribution to <latest>)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        makeMavenMetadataXml({ latest: "2.0.0", versions: ["1.0.0", "2.0.0"] }),
        { headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" } },
      ),
    );
    const result = await mavenMetadataVersions("com.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    // No version should receive the Last-Modified date — all are null
    expect(result.every((r) => r.publishDate === null)).toBe(true);
  });

  it("drops non-coercible, non-digit-prefixed versions before sorting", async () => {
    // "not-a-version" cannot be coerced and does not start with a digit, so it is
    // pre-filtered out (it would only pollute the sort with non-comparable junk).
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(makeMavenMetadataXml({ versions: ["1.0.0", "not-a-version", "2.0.0"] })),
    );
    const result = await mavenMetadataVersions("com.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    const versions = result.map((r) => r.version);
    expect(versions).toEqual(["2.0.0", "1.0.0"]);
    expect(versions).not.toContain("not-a-version");
  });

  it("returns empty array when metadata response is not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await mavenMetadataVersions("com.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    expect(result).toEqual([]);
  });

  it("tries next repo on failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(makeMavenMetadataXml({ versions: ["1.0.0", "2.0.0"] })),
      );
    const result = await mavenMetadataVersions(
      "com.example", "lib",
      ["https://private.repo/maven2", "https://repo1.maven.org/maven2"],
      registries,
    );
    expect(result).toHaveLength(2);
    expect(result[0].version).toBe("2.0.0");
  });

  it("sorts 2-segment Maven versions (e.g. 4.12, 4.13) correctly via coerce", async () => {
    // semver.valid("4.13") is null but semver.coerce("4.13") is "4.13.0"
    // XML document order is oldest-first; result must be newest-first
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(makeMavenMetadataXml({ versions: ["4.12", "4.13", "4.11"] })),
    );
    const result = await mavenMetadataVersions("junit", "junit", ["https://repo1.maven.org/maven2"], registries);
    expect(result.map((r) => r.version)).toEqual(["4.13", "4.12", "4.11"]);
  });

  it("sorts qualified Maven versions (e.g. 2.21.RELEASE, 3.0-rc5) via coerce", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(makeMavenMetadataXml({ versions: ["2.21.RELEASE", "3.0.0", "3.0-rc5"] })),
    );
    const result = await mavenMetadataVersions("org.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    const versions = result.map((r) => r.version);
    // 3.0.0 (coerces to 3.0.0) must come before 2.21.RELEASE (coerces to 2.21.0)
    expect(versions.indexOf("3.0.0")).toBeLessThan(versions.indexOf("2.21.RELEASE"));
  });

  // F2 regression: numeric-looking versions must NOT be coerced to JS numbers by
  // the XML parser (which would corrupt "4.10" → "4.1", "2.00" → "2").
  it("preserves numeric-looking versions verbatim as strings (no number coercion)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(makeMavenMetadataXml({ versions: ["4.10", "1.20", "2.00"] })),
    );
    const result = await mavenMetadataVersions("org.example", "lib", ["https://repo1.maven.org/maven2"], registries);
    const versions = result.map((r) => r.version);
    expect(versions).toContain("4.10");
    expect(versions).toContain("1.20");
    expect(versions).toContain("2.00");
    // The corrupted (number-coerced) forms must never appear.
    expect(versions).not.toContain("4.1");
    expect(versions).not.toContain("1.2");
    expect(versions).not.toContain("2");
  });

  // F3: distinguish "artifact has no versions" from "every repo was unreachable".
  it("throws an 'unreachable' error when all repos return a non-ok status", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      mavenMetadataVersions(
        "org.example", "lib",
        ["https://a.repo/maven2", "https://b.repo/maven2"],
        registries,
      ),
    ).rejects.toThrow(/unreachable/);
  });

  // Non-HTTPS repo coverage-loss visibility: requireHttpsMavenRepo silently skips a
  // non-HTTPS configured repo (SSRF prevention). Previously this was indistinguishable
  // downstream from "this repo answered cleanly with no matching artifact" and emitted
  // no log line at all.
  describe("non-HTTPS repo skip visibility", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      coreMock.warning.mockClear();
      _resetGitHubWarningFlags();
    });

    it("throws the 'all repos unreachable' error (not a silent []) when every configured repo is non-HTTPS", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(
        mavenMetadataVersions(
          "org.example", "lib",
          ["http://a.repo/maven2", "http://b.repo/maven2"],
          registries,
        ),
      ).rejects.toThrow(/unreachable/);
      // No network call should have been attempted for either non-HTTPS repo.
      expect(fetchSpy).not.toHaveBeenCalled();
      // Every skipped repo should be logged so the coverage loss is visible.
      expect(coreMock.warning).toHaveBeenCalledTimes(2);
      expect(coreMock.warning.mock.calls[0][0]).toMatch(/http:\/\/a\.repo\/maven2/);
      expect(coreMock.warning.mock.calls[1][0]).toMatch(/http:\/\/b\.repo\/maven2/);
    });

    it("logs the skip but still returns results when one repo is non-HTTPS and another (HTTPS) is reachable", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(makeMavenMetadataXml({ versions: ["1.0.0", "2.0.0"] })),
      );
      const result = await mavenMetadataVersions(
        "org.example", "lib",
        ["http://insecure.repo/maven2", "https://repo1.maven.org/maven2"],
        registries,
      );
      expect(result.map((r) => r.version)).toEqual(["2.0.0", "1.0.0"]);
      expect(coreMock.warning).toHaveBeenCalledTimes(1);
      expect(coreMock.warning.mock.calls[0][0]).toMatch(/http:\/\/insecure\.repo\/maven2/);
    });

    it("warns only once per repo across multiple lookups (dedup)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(
        mavenMetadataVersions("org.example", "lib1", ["http://a.repo/maven2"], registries),
      ).rejects.toThrow(/unreachable/);
      await expect(
        mavenMetadataVersions("org.example", "lib2", ["http://a.repo/maven2"], registries),
      ).rejects.toThrow(/unreachable/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(coreMock.warning).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── H1: sanePublishDate boundary conditions ─────────────────────────────────

describe("sanePublishDate (H1)", () => {
  it("returns null for NaN (unparseable string)", () => {
    expect(sanePublishDate("not-a-date")).toBeNull();
  });

  it("returns null for year < 2000 (1999-12-31)", () => {
    expect(sanePublishDate("1999-12-31T23:59:59Z")).toBeNull();
  });

  it("returns null for git zero-date sentinel (0001-01-01)", () => {
    expect(sanePublishDate("0001-01-01T00:00:00Z")).toBeNull();
  });

  it("returns null for far-future year (currentYear + 2)", () => {
    const futureYear = new Date().getFullYear() + 2;
    expect(sanePublishDate(`${futureYear}-01-01T00:00:00Z`)).toBeNull();
  });

  it("returns Date for a valid date in 2024", () => {
    const d = sanePublishDate("2024-01-15T10:00:00Z");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2024);
  });

  it("accepts current year (today's date)", () => {
    const d = sanePublishDate(new Date().toISOString());
    expect(d).not.toBeNull();
  });

  it("accepts a Date object directly", () => {
    const input = new Date("2023-06-15T00:00:00Z");
    const d = sanePublishDate(input);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(input.getTime());
  });

  it("returns null for null input", () => {
    expect(sanePublishDate(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(sanePublishDate(undefined)).toBeNull();
  });

  it("accepts currentYear + 1 (one year ahead is still sane)", () => {
    const nextYear = new Date().getFullYear() + 1;
    const d = sanePublishDate(`${nextYear}-06-01T00:00:00Z`);
    expect(d).not.toBeNull();
  });
});

describe("compareVersionsDesc (S1 — overflow guard)", () => {
  it("does not mis-rank a legitimate newer version against an overflowing segment", () => {
    // Without the overflow guard, semver.coerce("99999999999999999.0.0") coerces the
    // 17-digit segment via Number(), which loses precision beyond MAX_SAFE_INTEGER and
    // can produce 0 — making the overflowing version sort LAST (appearing "oldest").
    // The fix uses Number.isSafeInteger() to detect and treat these as non-comparable
    // so they fall to the end, not before legitimate semver versions.
    // (Previously used 99999999999 — 11 digits — but that is still a safe integer
    // so semver.coerce handled it correctly; the guard is only needed at >MAX_SAFE_INTEGER.)
    const overflowing = "99999999999999999.0.0"; // 17-digit segment > Number.MAX_SAFE_INTEGER
    const legitimate = "1.0.0";

    // compareVersionsDesc is a sort comparator (a < b in descending → negative).
    // "1.0.0" should sort before (be "newer than") the overflowing string.
    expect(compareVersionsDesc(legitimate, overflowing, true)).toBeLessThan(0);
    expect(compareVersionsDesc(overflowing, legitimate, true)).toBeGreaterThan(0);
  });

  it("still sorts normal semver correctly with useCoerce=true", () => {
    expect(compareVersionsDesc("2.0.0", "1.0.0", true)).toBeLessThan(0);
    expect(compareVersionsDesc("1.0.0", "2.0.0", true)).toBeGreaterThan(0);
  });

  it("M4: two different mutually-uncoercible strings produce a deterministic (non-zero) order", () => {
    // Both "apple" and "banana" don't coerce to semver. Previously the function returned 0,
    // relying on V8 sort stability + arbitrary input order (non-deterministic).
    // The fix adds a lexical tiebreaker: "banana" > "apple" → compareVersionsDesc("apple","banana",true) > 0.
    expect(compareVersionsDesc("apple", "banana", true)).toBeGreaterThan(0);
    expect(compareVersionsDesc("banana", "apple", true)).toBeLessThan(0);
    // Equal strings must still return 0.
    expect(compareVersionsDesc("apple", "apple", true)).toBe(0);
    // Symmetry: swapping arguments negates the result.
    expect(Math.sign(compareVersionsDesc("zebra", "aardvark", true))).toBe(
      -Math.sign(compareVersionsDesc("aardvark", "zebra", true)),
    );
  });

  it("handles 2-segment Maven versions correctly (coerce, not valid)", () => {
    // semver.valid("4.13") is null; semver.coerce("4.13") → "4.13.0"
    expect(compareVersionsDesc("4.13", "4.12", true)).toBeLessThan(0); // 4.13 > 4.12
    expect(compareVersionsDesc("4.12", "4.13", true)).toBeGreaterThan(0);
  });

  // P2.3: promotion-oracle adversarial coverage — semver.coerce("2.00") returns null
  // (leading zeros in a numeric segment aren't valid semver), so without the
  // normalizeLeadingZeros pre-pass a trailing-zero Maven version like "2.00" would be
  // treated as non-comparable and fall to the lexical-tiebreak path, sorting it
  // incorrectly relative to true semver versions.
  it("normalizes trailing-zero segments so '2.00'-style versions still compare correctly", () => {
    expect(compareVersionsDesc("2.10", "2.00", true)).toBeLessThan(0); // 2.10 > 2.00 (== 2.0)
    expect(compareVersionsDesc("2.00", "2.10", true)).toBeGreaterThan(0);
    expect(compareVersionsDesc("2.00", "1.99", true)).toBeLessThan(0); // 2.00 (== 2.0) > 1.99
    // "2.00" and "2.0" coerce to the same semver value, so rcompare is 0 and the
    // function falls through to the lexical tiebreak — not exact equality. Assert the
    // tiebreak is still a well-defined total order (antisymmetric), not arbitrary.
    expect(compareVersionsDesc("2.00", "2.0", true)).toBe(-compareVersionsDesc("2.0", "2.00", true));
  });
});

describe("XMLParser processEntities:false", () => {
  it("XMLParser with processEntities:false does not expand entities", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE lol [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<metadata><versioning><versions><version>&lol2;</version></versions></versioning></metadata>`;
    // Should not throw and should not produce a valid semver version
    const parser = new XMLParser({ parseTagValue: false, parseAttributeValue: false, processEntities: false });
    const result = parser.parse(xml);
    // The &lol2; reference stays unexpanded (literal string) — not a real version
    const versions = result?.metadata?.versioning?.versions?.version;
    const versionList = Array.isArray(versions) ? versions : versions ? [versions] : [];
    // None of the extracted "versions" should be valid semver (they're entity refs)
    for (const v of versionList) {
      expect(semver.valid(String(v))).toBeNull();
    }
  });
});
