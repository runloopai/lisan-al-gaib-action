import { describe, it, expect, vi } from "vitest";
import { createApiDiffSource } from "../src/api-diff.js";

const compareFiles = [
  { filename: "package.json", status: "modified" },
  { filename: "new-package.ts", status: "added" },
  { filename: "deleted.ts", status: "removed" },
  { filename: "renamed-new.ts", status: "renamed", previous_filename: "renamed-old.ts" },
];

function makeOctokit(
  files = compareFiles,
  getContentImpl?: (params: unknown) => Promise<unknown>,
) {
  return {
    rest: {
      repos: {
        compareCommits: vi.fn().mockResolvedValue({ data: { files } }),
        getContent: getContentImpl ? vi.fn().mockImplementation(getContentImpl) : vi.fn(),
      },
    },
  };
}

function makeSource(opts?: {
  files?: typeof compareFiles;
  getContentImpl?: (params: unknown) => Promise<unknown>;
}) {
  return createApiDiffSource({
    octokit: makeOctokit(opts?.files, opts?.getContentImpl) as any,
    owner: "owner",
    repo: "repo",
    baseSha: "basesha",
    headSha: "headsha",
  });
}

describe("createApiDiffSource — diffNameOnly", () => {
  it("returns all changed filenames from compareCommits", async () => {
    const source = makeSource();
    const files = await source.diffNameOnly();
    expect(files).toEqual(["package.json", "new-package.ts", "deleted.ts", "renamed-new.ts"]);
  });

  it("returns empty array when there are no changed files", async () => {
    const source = makeSource({ files: [] });
    expect(await source.diffNameOnly()).toEqual([]);
  });
});

describe("createApiDiffSource — diffFiltered", () => {
  it("returns only added files for filter A", async () => {
    const source = makeSource();
    const files = await source.diffFiltered("A");
    expect(files).toEqual(["new-package.ts"]);
  });

  it("excludes renamed files from filter A to match --diff-filter=A semantics", async () => {
    const source = makeSource({
      files: [
        { filename: "truly-new.ts", status: "added" },
        { filename: "renamed-new.ts", status: "renamed", previous_filename: "old.ts" },
      ],
    });
    const files = await source.diffFiltered("A");
    expect(files).toEqual(["truly-new.ts"]);
  });
});

describe("createApiDiffSource — diff", () => {
  it("returns non-empty string for a file present in the change set", async () => {
    const source = makeSource();
    expect(await source.diff("package.json")).not.toBe("");
  });

  it("returns empty string for a file not in the change set", async () => {
    const source = makeSource();
    expect(await source.diff("untouched.ts")).toBe("");
  });
});

describe("createApiDiffSource — showFile", () => {
  it("decodes base64 content from getContent", async () => {
    const content = Buffer.from("file contents here").toString("base64");
    const source = makeSource({
      getContentImpl: async () => ({
        data: { type: "file", content: content + "\n", encoding: "base64" },
      }),
    });
    expect(await source.showFile("file.ts")).toBe("file contents here");
  });

  it("returns null when file type is not 'file' (e.g. directory)", async () => {
    const source = makeSource({
      getContentImpl: async () => ({ data: { type: "dir" } }),
    });
    expect(await source.showFile("somedir")).toBeNull();
  });

  it("returns null when getContent returns 404", async () => {
    const source = makeSource({
      getContentImpl: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); },
    });
    expect(await source.showFile("missing.ts")).toBeNull();
  });

  it("fetches large files via download_url when content is empty", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () => "large file content",
    } as Response);

    const source = makeSource({
      getContentImpl: async () => ({
        data: { type: "file", content: "", encoding: "base64", download_url: "https://example.com/file.ts" },
      }),
    });
    expect(await source.showFile("large.ts")).toBe("large file content");
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/file.ts");

    fetchSpy.mockRestore();
  });
});

describe("createApiDiffSource — result caching", () => {
  it("calls compareCommits only once (single page) even when multiple primitives are invoked", async () => {
    const octokit = makeOctokit();
    const source = createApiDiffSource({
      octokit: octokit as any,
      owner: "owner",
      repo: "repo",
      baseSha: "basesha",
      headSha: "headsha",
    });
    await source.diffNameOnly();
    await source.diffFiltered("A");
    await source.diff("package.json");
    // 4 compare files < 100 per_page → single page
    expect(octokit.rest.repos.compareCommits).toHaveBeenCalledTimes(1);
  });
});

describe("createApiDiffSource — pagination", () => {
  it("fetches all pages when the first page is full (100 files)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `file${i}.ts`,
      status: "modified",
    }));
    const page2 = [{ filename: "final.ts", status: "added" }];
    const mockCompare = vi.fn()
      .mockResolvedValueOnce({ data: { files: page1 } })
      .mockResolvedValueOnce({ data: { files: page2 } });

    const source = createApiDiffSource({
      octokit: { rest: { repos: { compareCommits: mockCompare, getContent: vi.fn() } } } as any,
      owner: "o", repo: "r", baseSha: "b", headSha: "h",
    });

    const files = await source.diffNameOnly();
    expect(files).toHaveLength(101);
    expect(files).toContain("final.ts");
    expect(mockCompare).toHaveBeenCalledTimes(2);
  });

  it("stops fetching when a page returns fewer than per_page files", async () => {
    const mockCompare = vi.fn().mockResolvedValue({ data: { files: compareFiles } });  // 4 files < 100

    const source = createApiDiffSource({
      octokit: { rest: { repos: { compareCommits: mockCompare, getContent: vi.fn() } } } as any,
      owner: "o", repo: "r", baseSha: "b", headSha: "h",
    });

    await source.diffNameOnly();
    expect(mockCompare).toHaveBeenCalledTimes(1);
  });
});

describe("createApiDiffSource — compareCommits error handling", () => {
  it("propagates compareCommits error so caller can detect and degrade", async () => {
    const mockCompare = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const source = createApiDiffSource({
      octokit: { rest: { repos: { compareCommits: mockCompare, getContent: vi.fn() } } } as any,
      owner: "o", repo: "r", baseSha: "b", headSha: "h",
    });
    await expect(source.diffNameOnly()).rejects.toThrow("Not Found");
  });
});

describe("createApiDiffSource — M5 truncation guard", () => {
  it("throws when compareCommits returns 300 or more files (GitHub file-list cap reached)", async () => {
    // GitHub caps the compareCommits `files` array at ~300 entries. If we reach that
    // boundary, the list is truncated and silently dropping files would cause packages
    // to be skipped for age-gating. The implementation throws so callers can degrade
    // to check-all rather than silently under-check.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `a${i}.ts`, status: "modified" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ filename: `b${i}.ts`, status: "modified" }));
    const page3 = Array.from({ length: 100 }, (_, i) => ({ filename: `c${i}.ts`, status: "modified" }));
    const mockCompare = vi.fn()
      .mockResolvedValueOnce({ data: { files: page1 } })
      .mockResolvedValueOnce({ data: { files: page2 } })
      .mockResolvedValueOnce({ data: { files: page3 } });

    const source = createApiDiffSource({
      octokit: { rest: { repos: { compareCommits: mockCompare, getContent: vi.fn() } } } as any,
      owner: "o", repo: "r", baseSha: "b", headSha: "h",
    });

    await expect(source.diffNameOnly()).rejects.toThrow(/truncated/);
  });

  it("does not throw when exactly 299 files are returned across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `a${i}.ts`, status: "modified" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ filename: `b${i}.ts`, status: "modified" }));
    const page3 = Array.from({ length: 99 },  (_, i) => ({ filename: `c${i}.ts`, status: "modified" }));
    const mockCompare = vi.fn()
      .mockResolvedValueOnce({ data: { files: page1 } })
      .mockResolvedValueOnce({ data: { files: page2 } })
      .mockResolvedValueOnce({ data: { files: page3 } }); // <100 → last page, stop

    const source = createApiDiffSource({
      octokit: { rest: { repos: { compareCommits: mockCompare, getContent: vi.fn() } } } as any,
      owner: "o", repo: "r", baseSha: "b", headSha: "h",
    });

    const files = await source.diffNameOnly();
    expect(files).toHaveLength(299);
  });
});

describe("createApiDiffSource — showFile error handling", () => {
  it("propagates non-404 errors (e.g. rate limit 403) so callers can fail-closed", async () => {
    // Swallowing a 403/429/5xx would silently skip existence checks that are
    // transient failures — the caller must see the error to decide whether to
    // degrade to check-all.
    const source = makeSource({
      getContentImpl: async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      },
    });
    await expect(source.showFile("locked.ts")).rejects.toThrow("Forbidden");
  });
});
