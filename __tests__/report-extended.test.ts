import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  summary: {
    addRaw: vi.fn().mockReturnThis(),
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
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

  it("emits error for fail status", () => {
    emitAnnotations([makeResult({ status: "fail", ageDays: 3 })], 14);
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("3d ago"),
      expect.objectContaining({ file: "pnpm-lock.yaml" }),
    );
  });

  it("emits warning for warn status", () => {
    emitAnnotations([makeResult({ status: "warn", ageDays: 15 })], 14);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("15d ago"),
      expect.objectContaining({ file: "pnpm-lock.yaml" }),
    );
  });

  it("does not emit for pass or unknown", () => {
    emitAnnotations(
      [makeResult({ status: "pass" }), makeResult({ status: "unknown" })],
      14,
    );
    expect(core.error).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("emits remediation hint for pnpm", () => {
    emitAnnotations(
      [makeResult({ status: "fail", dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "pnpm-lock.yaml" } })],
      14,
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("pnpm-workspace.yaml"));
  });

  it("emits remediation hint for yarn", () => {
    emitAnnotations(
      [makeResult({ status: "fail", dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "yarn.lock" } })],
      14,
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining(".yarnrc.yml"));
  });

  it("emits remediation hint for bun", () => {
    emitAnnotations(
      [makeResult({ status: "fail", dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "bun.lock" } })],
      14,
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("bunfig.toml"));
  });

  it("emits remediation hint for python", () => {
    emitAnnotations(
      [makeResult({ status: "fail", dep: { ecosystem: "python", name: "pkg", version: "1.0.0", file: "uv.lock" } })],
      14,
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("pyproject.toml"));
  });

  it("no remediation hint for package-lock.json", () => {
    emitAnnotations(
      [makeResult({ status: "fail", dep: { ecosystem: "npm", name: "pkg", version: "1.0.0", file: "package-lock.json" } })],
      14,
    );
    // Should still emit error but no remediation hint file
    expect(core.error).toHaveBeenCalled();
    const infoCalls = vi.mocked(core.info).mock.calls.map(c => c[0]);
    expect(infoCalls.some(c => c.includes("Add to"))).toBe(false);
  });

  it("deduplicates remediation hints per file", () => {
    emitAnnotations(
      [
        makeResult({ status: "fail", dep: { ecosystem: "npm", name: "a", version: "1.0.0", file: "pnpm-lock.yaml" } }),
        makeResult({ status: "fail", dep: { ecosystem: "npm", name: "b", version: "2.0.0", file: "pnpm-lock.yaml" } }),
      ],
      14,
    );
    const hintCalls = vi.mocked(core.info).mock.calls.filter(c =>
      (c[0] as string).includes("pnpm-workspace.yaml"),
    );
    expect(hintCalls).toHaveLength(1);
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
