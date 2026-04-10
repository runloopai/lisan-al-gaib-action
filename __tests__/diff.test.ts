import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/exec", () => ({
  exec: vi.fn(),
}));

vi.mock("@actions/glob", () => ({
  create: vi.fn(),
}));

import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import { gitDiff, gitDiffFiltered, gitDiffNameOnly, gitShowFile, resolveFiles } from "../src/diff.js";

describe("gitDiff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns diff output", async () => {
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("diff content"));
      return 0;
    });
    expect(await gitDiff("HEAD~1", "file.txt")).toBe("diff content");
  });

  it("returns empty string on no diff", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    expect(await gitDiff("HEAD~1", "file.txt")).toBe("");
  });
});

describe("gitDiffFiltered", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns filtered files", async () => {
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("file1.ts\nfile2.ts\n"));
      return 0;
    });
    const files = await gitDiffFiltered("HEAD~1", "A");
    expect(files).toEqual(["file1.ts", "file2.ts"]);
  });

  it("returns empty for no output", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    expect(await gitDiffFiltered("HEAD~1", "A")).toEqual([]);
  });
});

describe("gitDiffNameOnly", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns changed file names", async () => {
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("a.ts\nb.ts\n"));
      return 0;
    });
    expect(await gitDiffNameOnly("HEAD~1")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("gitShowFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns file content on success", async () => {
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("file content"));
      return 0;
    });
    expect(await gitShowFile("HEAD~1", "file.txt")).toBe("file content");
  });

  it("returns null on failure", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    expect(await gitShowFile("HEAD~1", "file.txt")).toBeNull();
  });
});

describe("resolveFiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves glob patterns to relative paths", async () => {
    vi.mocked(glob.create).mockResolvedValueOnce({
      glob: async () => [`${process.cwd()}/src/main.ts`],
    } as any);
    const files = await resolveFiles("src/*.ts");
    expect(files).toEqual(["src/main.ts"]);
  });

  it("includes literal paths that dont match globs", async () => {
    vi.mocked(glob.create).mockResolvedValueOnce({
      glob: async () => [],
    } as any);
    const files = await resolveFiles("nonexistent.yaml");
    expect(files).toEqual(["nonexistent.yaml"]);
  });

  it("handles multiple entries", async () => {
    vi.mocked(glob.create)
      .mockResolvedValueOnce({ glob: async () => [`${process.cwd()}/a.ts`] } as any)
      .mockResolvedValueOnce({ glob: async () => [`${process.cwd()}/b.ts`] } as any);
    const files = await resolveFiles("a.ts\nb.ts");
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  it("skips empty lines", async () => {
    vi.mocked(glob.create).mockResolvedValueOnce({
      glob: async () => [`${process.cwd()}/a.ts`],
    } as any);
    const files = await resolveFiles("\n  \na.ts\n");
    expect(files).toEqual(["a.ts"]);
  });

  it("does not include literal path for glob patterns with no match", async () => {
    vi.mocked(glob.create).mockResolvedValueOnce({
      glob: async () => [],
    } as any);
    const files = await resolveFiles("src/*.xyz");
    expect(files).toEqual([]);
  });
});
