/**
 * Tests for docker/kubernetes resolveLatest: always pin-in-place.
 * Verifies that both digest-less (first-run) and already-pinned (second-run)
 * refs preserve the author's tag (never bump to a different tag).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { resolveLatest } from "../src/update/latest.js";
import * as registry from "../src/registry.js";

const TEST_REGISTRIES = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
  maven: "https://repo1.maven.org/maven2",
};

const BASE_OPTS = {
  mode: "major" as const,
  minAgeDays: 14,
  token: "",
  registries: TEST_REGISTRIES,
};

const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 86_400_000);
const FIXED_DIGEST = "sha256:deadbeef000000000000000000000000000000000000000000000000000000001";

beforeEach(() => vi.clearAllMocks());

describe("resolveLatest docker — first run (digest-less mutable tag)", () => {
  it("returns pinInPlace=true with the original tag preserved", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(THIRTY_DAYS_AGO);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/python",
        file: "/Dockerfile",
        current: "3.12-slim-bookworm",
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].version).toBe("3.12-slim-bookworm");
  });

  it("returns pinInPlace=true for a bare tag with no colon (e.g. 'latest')", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(THIRTY_DAYS_AGO);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/ubuntu",
        file: "/Dockerfile",
        current: "latest",
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.versions[0].version).toBe("latest");
  });
});

describe("resolveLatest docker — second run (already digest-pinned ref)", () => {
  it("returns pinInPlace=true with the tag from dep.current, never consulting ociTags", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(THIRTY_DAYS_AGO);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/python",
        file: "/Dockerfile",
        // makeVersion produces "tag@sha256:..." for already-pinned refs
        current: `3.12-slim-bookworm@${FIXED_DIGEST}`,
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.versions).toHaveLength(1);
    // Must preserve the author's tag, not bump to something else
    expect(result.versions[0].version).toBe("3.12-slim-bookworm");
  });

  it("strips the full digest portion (sha256:long-hash) to extract the bare tag", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(THIRTY_DAYS_AGO);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/golang",
        file: "/Dockerfile",
        current: `1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac`,
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.versions[0].version).toBe("1.24-bookworm");
  });

  it("works the same for the kubernetes ecosystem", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(THIRTY_DAYS_AGO);

    const result = await resolveLatest(
      {
        ecosystem: "kubernetes",
        name: "docker.io/library/nginx",
        file: "/manifests/deploy.yaml",
        current: `1.27-alpine@${FIXED_DIGEST}`,
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.versions[0].version).toBe("1.27-alpine");
  });
});

describe("resolveLatest docker — digest resolution failures", () => {
  it("returns pinInPlace=true with null ageDays when ociDigestForTag returns null", async () => {
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(null);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/python",
        file: "/Dockerfile",
        current: "3.12-slim-bookworm",
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.versions[0].version).toBe("3.12-slim-bookworm");
    expect(result.currentAgeDays).toBeNull();
    expect(vi.mocked(registry.fetchImagePublishDate)).not.toHaveBeenCalled();
  });

  it("returns empty versions when parseImageRef returns null (invalid image ref)", async () => {
    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "not-a-valid:image:ref:extra-colon",
        file: "/Dockerfile",
        current: "some-tag",
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.versions).toHaveLength(0);
    expect(result.currentAgeDays).toBeNull();
  });

  it("digest resolves but publish date is unavailable: resolvedDigest is still returned, ageDays is null (fail-closed)", async () => {
    // The registry positively confirms the digest exists, but the image config blob
    // has no readable created/publish-date label — age is unconfirmable, not zero.
    // buildCandidates enforces the actual age gate on this null downstream; resolveLatest's
    // job here is only to surface null rather than fabricate a passing age.
    vi.mocked(registry.ociDigestForTag).mockResolvedValue(FIXED_DIGEST);
    vi.mocked(registry.fetchImagePublishDate).mockResolvedValue(null);

    const result = await resolveLatest(
      {
        ecosystem: "docker",
        name: "docker.io/library/python",
        file: "/Dockerfile",
        current: "3.12-slim-bookworm",
        position: {},
      },
      BASE_OPTS,
    );

    expect(result.pinInPlace).toBe(true);
    expect(result.resolvedDigest).toBe(FIXED_DIGEST);
    expect(result.currentAgeDays).toBeNull();
    expect(result.versions[0].ageDays).toBeNull();
  });
});
