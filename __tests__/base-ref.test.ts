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
import { resolveBaseRef, validateBaseRef } from "../src/base-ref.js";

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
