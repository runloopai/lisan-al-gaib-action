import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
}));

import {
  npmPublishDate,
  pypiPublishDate,
  cratesPublishDate,
  mavenPublishDate,
  gitCommitDate,
  archiveDate,
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
        JSON.stringify({ time: { "1.0.0": "2024-01-15T00:00:00.000Z" } }),
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
      );
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

describe("bcrPublishDate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns date from GitHub commits API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { commit: { committer: { date: "2024-05-01T00:00:00Z" } } },
        ]),
      ),
    );
    const { bcrPublishDate } = await import("../src/registry.js");
    const date = await bcrPublishDate("rules_java", "8.0.0", "token", "https://bcr.bazel.build");
    expect(date).toEqual(new Date("2024-05-01T00:00:00Z"));
  });

  it("falls back to source.json archive", async () => {
    vi.spyOn(globalThis, "fetch")
      // GitHub commits API returns empty
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // source.json
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://example.com/archive.tar.gz" })),
      )
      // HEAD on archive URL
      .mockResolvedValueOnce(
        new Response(null, { headers: { "Last-Modified": "Fri, 01 Mar 2024 00:00:00 GMT" } }),
      );
    const { bcrPublishDate } = await import("../src/registry.js");
    const date = await bcrPublishDate("mod", "1.0", "", "https://bcr.bazel.build");
    expect(date).toEqual(new Date("Fri, 01 Mar 2024 00:00:00 GMT"));
  });

  it("returns null when everything fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const { bcrPublishDate } = await import("../src/registry.js");
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
    const { bcrPublishDate } = await import("../src/registry.js");
    await bcrPublishDate("mod", "1.0", "", "https://github.com/my-org/my-bcr");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("my-org/my-bcr"),
      expect.anything(),
    );
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
