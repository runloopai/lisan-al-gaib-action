import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  summary: {
    addRaw: vi.fn().mockReturnThis(),
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@actions/exec", () => ({
  exec: vi.fn().mockResolvedValue(0),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-org", repo: "test-repo" },
  },
}));

vi.mock("@actions/glob", () => ({
  create: vi.fn().mockResolvedValue({ glob: vi.fn().mockResolvedValue([]) }),
}));

import * as core from "@actions/core";
import {
  emitAnnotations,
  writeSummary,
} from "../src/report.js";
import type { CheckResult } from "../src/ecosystems/types.js";

function makeResult(
  overrides: Partial<CheckResult> & { status: CheckResult["status"] },
): CheckResult {
  return {
    dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "pnpm-lock.yaml" },
    publishDate: null,
    ageDays: 5,
    ...overrides,
  };
}

describe("emitAnnotations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits error for fail status", async () => {
    await emitAnnotations([makeResult({ status: "fail", ageDays: 3 })], ["npm"], 14);
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("3d ago"),
      expect.objectContaining({ file: "pnpm-lock.yaml" }),
    );
  });

  it("emits warning for warn status", async () => {
    await emitAnnotations([makeResult({ status: "warn", ageDays: 15 })], ["npm"], 14);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("15d ago"),
      expect.objectContaining({ file: "pnpm-lock.yaml" }),
    );
  });

  it("does not emit for pass or unknown", async () => {
    await emitAnnotations(
      [makeResult({ status: "pass" }), makeResult({ status: "unknown" })],
      ["npm"],
      14,
    );
    expect(core.error).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });
});

describe("writeSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes 'no changes' message when empty", async () => {
    await writeSummary([], 14, 21);
    expect(core.summary.addRaw).toHaveBeenCalledWith("No dependency changes detected.");
  });

  it("writes table with results", async () => {
    await writeSummary(
      [makeResult({ status: "fail", ageDays: 3 })],
      14,
      21,
    );
    expect(core.summary.addHeading).toHaveBeenCalledWith("Lisan al-Gaib", 2);
    expect(core.summary.addTable).toHaveBeenCalled();
  });

  it("includes Runloop footer", async () => {
    await writeSummary([], 14, 21);
    expect(core.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining("Runloop AI"),
    );
  });

  it("includes license table when results provided", async () => {
    await writeSummary(
      [makeResult({ status: "pass" })],
      14,
      21,
      [{ name: "pkg", version: "1.0.0", ecosystem: "npm", license: "MIT", spdx: "MIT", compatible: true }],
    );
    expect(core.summary.addHeading).toHaveBeenCalledWith("License Compliance", 2);
  });
});
