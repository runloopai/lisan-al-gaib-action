import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/exec", () => ({
  exec: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    eventName: "push",
    payload: {},
    repo: { owner: "owner", repo: "repo" },
    sha: "abc123",
  },
  getOctokit: vi.fn(),
}));

import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { checkBypass, isPrEvent, INTERACTIVE_PUSH_EVENTS } from "../src/bypass.js";

function setEvent(
  eventName: string,
  payload: Record<string, unknown> = {},
): void {
  Object.assign(github.context, { eventName, payload });
}

function mockGitLog(message: string): void {
  vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
    opts?.listeners?.stdout?.(Buffer.from(message));
    return 0;
  });
}

function mockOctokit(
  prs: Array<{ labels: Array<{ name: string }> }>,
): void {
  vi.mocked(github.getOctokit).mockReturnValueOnce({
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({ data: prs }),
      },
    },
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(github.context, {
    eventName: "push",
    payload: {},
    repo: { owner: "owner", repo: "repo" },
    sha: "abc123",
  });
});

describe("isPrEvent", () => {
  it("returns true for pull_request", () => {
    setEvent("pull_request");
    expect(isPrEvent()).toBe(true);
  });

  it("returns true for pull_request_target", () => {
    setEvent("pull_request_target");
    expect(isPrEvent()).toBe(true);
  });

  it("returns false for push", () => {
    setEvent("push");
    expect(isPrEvent()).toBe(false);
  });
});

describe("checkBypass — pull_request event", () => {
  beforeEach(() => {
    setEvent("pull_request", {
      pull_request: {
        labels: [{ name: "cve-fix" }],
        body: "cve-fix\n",
      },
    });
  });

  it("returns true when PR has matching label", async () => {
    expect(await checkBypass("cve-fix", "token")).toBe(true);
  });

  it("returns false when label does not match", async () => {
    setEvent("pull_request", { pull_request: { labels: [{ name: "other" }], body: "" } });
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("ignores keyword in PR body", async () => {
    setEvent("pull_request", { pull_request: { labels: [], body: "cve-fix\n" } });
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("ignores keyword in commit message", async () => {
    setEvent("pull_request", { pull_request: { labels: [], body: "" } });
    mockGitLog("cve-fix\n");
    expect(await checkBypass("cve-fix", "token")).toBe(false);
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it("returns false when no labels field", async () => {
    setEvent("pull_request", { pull_request: { body: "cve-fix" } });
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });
});

describe("checkBypass — pull_request_target event", () => {
  it("returns true when PR has matching label", async () => {
    setEvent("pull_request_target", {
      pull_request: { labels: [{ name: "cve-fix" }], body: "" },
    });
    expect(await checkBypass("cve-fix", "token")).toBe(true);
  });

  it("ignores keyword in PR body", async () => {
    setEvent("pull_request_target", {
      pull_request: { labels: [], body: "cve-fix\n" },
    });
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("ignores commit message on pull_request_target", async () => {
    setEvent("pull_request_target", { pull_request: { labels: [] } });
    mockGitLog("cve-fix\n");
    expect(await checkBypass("cve-fix", "token")).toBe(false);
    expect(exec.exec).not.toHaveBeenCalled();
  });
});

describe("checkBypass — unattended events (schedule / workflow_dispatch / workflow_run / merge_group)", () => {
  // M6: pre-planted commit messages must not bypass on unattended triggers. Only the
  // label path (PR label) is checked; git log must never be called for these events.
  for (const eventName of ["schedule", "workflow_dispatch", "workflow_run", "merge_group"]) {
    it(`${eventName}: does NOT fire commit-message bypass even if keyword is in commit`, async () => {
      setEvent(eventName);
      // If git log were called it would return the bypass keyword — but it must not be called.
      vi.mocked(exec.exec).mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from("cve-fix\n"));
        return 0;
      });
      const result = await checkBypass("cve-fix", "token");
      expect(result).toBe(false);
      expect(exec.exec).not.toHaveBeenCalled();
    });

    it(`${eventName}: returns false (no PR labels to check)`, async () => {
      setEvent(eventName);
      expect(await checkBypass("cve-fix", "")).toBe(false);
      expect(exec.exec).not.toHaveBeenCalled();
    });
  }
});

describe("checkBypass — push event (non-PR)", () => {
  it("returns true when keyword is on its own line in commit message", async () => {
    setEvent("push");
    mockGitLog("fix: stuff\n\ncve-fix\n\nmore text\n");
    mockOctokit([]);
    expect(await checkBypass("cve-fix", "token")).toBe(true);
  });

  it("returns false when keyword appears inline in commit message (not own line)", async () => {
    setEvent("push");
    mockGitLog("fix: cve-fix stuff\n");
    mockOctokit([]);
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("returns true when commit message lacks keyword but associated PR has matching label", async () => {
    setEvent("push");
    mockGitLog("regular commit\n");
    mockOctokit([{ labels: [{ name: "cve-fix" }] }]);
    expect(await checkBypass("cve-fix", "token")).toBe(true);
  });

  it("returns false when associated PR has keyword only in body (not labels)", async () => {
    setEvent("push");
    mockGitLog("regular commit\n");
    // The mock receives no body field — only labels are checked
    mockOctokit([{ labels: [{ name: "other" }] }]);
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("returns false when nothing matches", async () => {
    setEvent("push");
    mockGitLog("regular commit\n");
    mockOctokit([]);
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("falls back gracefully when API throws", async () => {
    setEvent("push");
    mockGitLog("regular commit\n");
    vi.mocked(github.getOctokit).mockReturnValueOnce({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockRejectedValue(new Error("net err")),
        },
      },
    } as never);
    expect(await checkBypass("cve-fix", "token")).toBe(false);
  });

  it("skips API lookup when no token provided", async () => {
    setEvent("push");
    mockGitLog("regular commit\n");
    expect(await checkBypass("cve-fix", "")).toBe(false);
    expect(github.getOctokit).not.toHaveBeenCalled();
  });

  it("falls back gracefully when git is unavailable", async () => {
    setEvent("push");
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error("git not found"));
    mockOctokit([{ labels: [{ name: "cve-fix" }] }]);
    expect(await checkBypass("cve-fix", "token")).toBe(true);
  });
});

// A5: INTERACTIVE_PUSH_EVENTS — ensures the export drives the three-way bypass hint in main.ts
describe("INTERACTIVE_PUSH_EVENTS", () => {
  it("contains 'push' (the only event where commit-message bypass is accepted)", () => {
    expect(INTERACTIVE_PUSH_EVENTS.has("push")).toBe(true);
  });

  it("does not contain unattended events — commit-message bypass must not fire on them", () => {
    for (const event of ["schedule", "workflow_dispatch", "workflow_run"]) {
      expect(INTERACTIVE_PUSH_EVENTS.has(event)).toBe(false);
    }
  });

  it("does not contain PR events — those use the label-only path", () => {
    for (const event of ["pull_request", "pull_request_target"]) {
      expect(INTERACTIVE_PUSH_EVENTS.has(event)).toBe(false);
    }
  });

  // Regression: the three-way hint logic used in main.ts must map events correctly.
  // isPrEvent() → label-only hint
  // INTERACTIVE_PUSH_EVENTS.has(event) → commit-or-label hint
  // else → label-only hint with note that commit bypass is disabled
  it("three-way hint logic: isPrEvent() and INTERACTIVE_PUSH_EVENTS partition events correctly", () => {
    const prEvents = ["pull_request", "pull_request_target"];
    const pushEvents = [...INTERACTIVE_PUSH_EVENTS];
    const unattended = ["schedule", "workflow_dispatch", "workflow_run", "merge_group"];

    // No overlap between the three categories
    for (const e of prEvents) {
      expect(INTERACTIVE_PUSH_EVENTS.has(e)).toBe(false);
    }
    for (const e of pushEvents) {
      // push events should not be PR events
      setEvent(e);
      expect(isPrEvent()).toBe(false);
    }
    for (const e of unattended) {
      expect(INTERACTIVE_PUSH_EVENTS.has(e)).toBe(false);
      setEvent(e);
      expect(isPrEvent()).toBe(false);
    }
  });
});
