import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";

// F1 regression: @actions/core writes GitHub Actions workflow commands
// (::warning::, ::error::, etc.) directly to process.stdout regardless of whether
// a real Actions runner is present. installActionsCommandFilter() must redirect
// those (and any other plain stdout write) to stderr, while writeRawStdout() must
// always reach the real stdout — this is what keeps `update --json`'s printed
// payload pure JSON even when a warning fires earlier in the same run.
describe("actions-stdout", () => {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const hadGithubActions = "GITHUB_ACTIONS" in process.env;
  const originalGithubActions = process.env.GITHUB_ACTIONS;

  beforeEach(() => {
    delete process.env.GITHUB_ACTIONS;
    vi.resetModules();
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (hadGithubActions) process.env.GITHUB_ACTIONS = originalGithubActions;
    else delete process.env.GITHUB_ACTIONS;
    vi.resetModules();
  });

  it("redirects a core.warning ::warning:: line to stderr, never to the real stdout", async () => {
    const stdoutSpy = vi.fn(() => true);
    // Captured as the module's "pristine" stdout write at import time, below.
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;

    const { installActionsCommandFilter } = await import("../src/actions-stdout.js");

    const stderrSpy = vi.fn(() => true);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;

    installActionsCommandFilter();

    core.warning("something went sideways");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain("something went sideways");
  });

  it("redirects a plain core.info line (no :: prefix) to stderr too", async () => {
    const stdoutSpy = vi.fn(() => true);
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;

    const { installActionsCommandFilter } = await import("../src/actions-stdout.js");

    const stderrSpy = vi.fn(() => true);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;

    installActionsCommandFilter();

    core.info("just some info");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain("just some info");
  });

  it("writeRawStdout reaches the real stdout even after the filter is installed", async () => {
    const stdoutSpy = vi.fn(() => true);
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;

    const { installActionsCommandFilter, writeRawStdout } = await import("../src/actions-stdout.js");
    installActionsCommandFilter();

    writeRawStdout('{"pure":"json"}\n');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith('{"pure":"json"}\n');
  });

  it("a warning fired between two writeRawStdout calls never lands between them on stdout", async () => {
    // End-to-end shape of the actual bug: run() emits warnings via core.warning while
    // building candidates, then prints the final JSON via writeRawStdout. Only the
    // JSON text (never any ::warning:: line) may appear on the real stdout stream.
    const stdoutCalls: string[] = [];
    process.stdout.write = ((chunk: string) => {
      stdoutCalls.push(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;

    const { installActionsCommandFilter, writeRawStdout } = await import("../src/actions-stdout.js");

    const stderrCalls: string[] = [];
    process.stderr.write = ((chunk: string) => {
      stderrCalls.push(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;

    installActionsCommandFilter();

    core.warning("a warning that must not corrupt the JSON payload");
    writeRawStdout(JSON.stringify({ ok: true }));

    expect(stdoutCalls).toEqual([JSON.stringify({ ok: true })]);
    expect(stderrCalls.some((c) => c.includes("a warning that must not corrupt the JSON payload"))).toBe(true);
  });

  it("is a no-op when GITHUB_ACTIONS is set — real Actions runners must see the genuine ::warning:: line", async () => {
    process.env.GITHUB_ACTIONS = "true";

    const stdoutSpy = vi.fn(() => true);
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;

    const { installActionsCommandFilter } = await import("../src/actions-stdout.js");
    installActionsCommandFilter();

    core.warning("real annotation");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy.mock.calls[0][0]).toContain("::warning::");
    expect(stdoutSpy.mock.calls[0][0]).toContain("real annotation");
  });
});
