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
  fetchImagePublishDate,
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
