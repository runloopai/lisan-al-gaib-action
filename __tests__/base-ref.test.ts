import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @actions/github, @actions/core, @actions/exec before importing
vi.mock("@actions/github", () => ({
  context: {
    eventName: "push",
    payload: {},
  },
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/exec", () => ({
  exec: vi.fn(),
}));

import * as github from "@actions/github";
import * as exec from "@actions/exec";
import { resolveBaseRef, validateBaseRef, makeBaseRefDiffable } from "../src/base-ref.js";

describe("resolveBaseRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns provided input when non-empty", () => {
    expect(resolveBaseRef("abc123")).toBe("abc123");
  });

  it("returns PR base SHA for pull_request event", () => {
    Object.assign(github.context, {
      eventName: "pull_request",
      payload: { pull_request: { base: { sha: "pr-base-sha" } } },
    });
    expect(resolveBaseRef("")).toBe("pr-base-sha");
  });

  it("returns PR base SHA for pull_request_target event", () => {
    Object.assign(github.context, {
      eventName: "pull_request_target",
      payload: { pull_request: { base: { sha: "prt-sha" } } },
    });
    expect(resolveBaseRef("")).toBe("prt-sha");
  });

  it("returns merge_group base_sha", () => {
    Object.assign(github.context, {
      eventName: "merge_group",
      payload: { merge_group: { base_sha: "mg-sha" } },
    });
    expect(resolveBaseRef("")).toBe("mg-sha");
  });

  it("returns push before SHA", () => {
    Object.assign(github.context, {
      eventName: "push",
      payload: { before: "push-before" },
    });
    expect(resolveBaseRef("")).toBe("push-before");
  });

  it("skips zero SHA on push", () => {
    Object.assign(github.context, {
      eventName: "push",
      payload: { before: "0000000000000000000000000000000000000000" },
    });
    expect(resolveBaseRef("")).toBe("HEAD~1");
  });

  it("returns release target_commitish", () => {
    Object.assign(github.context, {
      eventName: "release",
      payload: { release: { target_commitish: "main" } },
    });
    expect(resolveBaseRef("")).toBe("main");
  });

  it("falls back to HEAD~1 for schedule event", () => {
    Object.assign(github.context, {
      eventName: "schedule",
      payload: {},
    });
    expect(resolveBaseRef("")).toBe("HEAD~1");
  });

  it("falls back to HEAD~1 for workflow_dispatch", () => {
    Object.assign(github.context, {
      eventName: "workflow_dispatch",
      payload: {},
    });
    expect(resolveBaseRef("")).toBe("HEAD~1");
  });

  it("falls back to HEAD~1 when PR has no base sha", () => {
    Object.assign(github.context, {
      eventName: "pull_request",
      payload: { pull_request: {} },
    });
    expect(resolveBaseRef("")).toBe("HEAD~1");
  });
});

describe("validateBaseRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ref if it exists", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    expect(await validateBaseRef("abc123")).toBe("abc123");
  });

  it("falls back to parent SHA when ref doesn't exist", async () => {
    // refExists fails
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    // getParentSha succeeds
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("parent-sha\n"));
      return 0;
    });
    expect(await validateBaseRef("bad-ref")).toBe("parent-sha");
  });

  it("falls back to origin/main when parent also fails", async () => {
    // refExists(ref) fails
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    // getParentSha fails
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    // refExists("origin/main") succeeds
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    expect(await validateBaseRef("bad-ref")).toBe("origin/main");
  });

  it("falls back to empty tree when everything fails", async () => {
    vi.mocked(exec.exec).mockResolvedValue(1);
    expect(await validateBaseRef("bad-ref")).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });
});

describe("makeBaseRefDiffable", () => {
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(github.context, { eventName: "schedule", payload: {}, sha: "headsha" });
  });

  it("passes the empty-tree sentinel through without any git calls", async () => {
    const result = await makeBaseRefDiffable(EMPTY_TREE, { fetchRetries: 3 });
    expect(result).toEqual({ mode: "git", baseRef: EMPTY_TREE });
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it("deepens shallow clone before resolving HEAD~1 to a concrete parent SHA", async () => {
    // isShallowRepo → true
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("true\n"));
      return 0;
    });
    // deepenLoop: countCommits before → 1
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("1\n"));
      return 0;
    });
    // deepenLoop: git fetch --deepen
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    // deepenLoop: isShallowRepo after → false (shallow boundary reached, break)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("false\n"));
      return 0;
    });
    // revParse("HEAD~1^{commit}") → concrete SHA
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("abc123\n"));
      return 0;
    });
    // canDiffCommits("abc123") → success
    vi.mocked(exec.exec).mockResolvedValueOnce(0);

    const result = await makeBaseRefDiffable("HEAD~1", { fetchRetries: 3 });
    expect(result).toEqual({ mode: "git", baseRef: "abc123" });
  });

  it("stops deepening when no progress is made and falls back to empty tree when no parent exists", async () => {
    // isShallowRepo → true (still shallow at start)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("true\n"));
      return 0;
    });
    // deepenLoop: countCommits before → 5
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("5\n"));
      return 0;
    });
    // deepenLoop: git fetch --deepen
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    // deepenLoop: isShallowRepo → still true (don't break yet)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("true\n"));
      return 0;
    });
    // deepenLoop: countCommits after → 5 (same as before → no progress, break)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("5\n"));
      return 0;
    });
    // revParse("HEAD~1^{commit}") → not found (initial commit, no parent)
    vi.mocked(exec.exec).mockResolvedValueOnce(1);

    const result = await makeBaseRefDiffable("HEAD~1", { fetchRetries: 3 });
    expect(result).toEqual({ mode: "git", baseRef: EMPTY_TREE });
  });

  it("treats a forced-push before-SHA as HEAD~1 and resolves the parent commit instead", async () => {
    Object.assign(github.context, {
      eventName: "push",
      payload: { forced: true, before: "forcedsha" },
    });
    // isShallowRepo → false (non-shallow, skip deepenLoop)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("false\n"));
      return 0;
    });
    // revParse("HEAD~1^{commit}") → parentsha
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("parentsha\n"));
      return 0;
    });
    // canDiffCommits("parentsha") → success
    vi.mocked(exec.exec).mockResolvedValueOnce(0);

    const result = await makeBaseRefDiffable("forcedsha", { fetchRetries: 3 });
    expect(result).toEqual({ mode: "git", baseRef: "parentsha" });
  });

  it("fetches a missing SHA on a shallow clone and returns git mode when diff succeeds", async () => {
    // refExists("deadbeef") → not found
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    // isShallowRepo → true
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("true\n"));
      return 0;
    });
    // fetchBySha("deadbeef") → success
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    // deepenLoop: countCommits before → 1
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("1\n"));
      return 0;
    });
    // deepenLoop: git fetch --deepen
    vi.mocked(exec.exec).mockResolvedValueOnce(0);
    // deepenLoop: isShallowRepo → false (boundary → break)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("false\n"));
      return 0;
    });
    // canDiffCommits("deadbeef") → success
    vi.mocked(exec.exec).mockResolvedValueOnce(0);

    const result = await makeBaseRefDiffable("deadbeef", { fetchRetries: 3 });
    expect(result).toEqual({ mode: "git", baseRef: "deadbeef" });
  });

  it("returns api mode when a SHA is not locally diffable after all fetch attempts", async () => {
    Object.assign(github.context, { sha: "headsha123" });
    // refExists("deadbeef456") → not found
    vi.mocked(exec.exec).mockResolvedValueOnce(1);
    // isShallowRepo → false (not shallow, skip fetchBySha/deepenLoop)
    vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from("false\n"));
      return 0;
    });
    // canDiffCommits("deadbeef456") → fail
    vi.mocked(exec.exec).mockResolvedValueOnce(1);

    const result = await makeBaseRefDiffable("deadbeef456", { fetchRetries: 3 });
    expect(result).toEqual({ mode: "api", baseSha: "deadbeef456", headSha: "headsha123" });
  });
});
