import { describe, it, expect } from "vitest";
import { parseMultitoolLock, findChangedTools } from "../src/ecosystems/multitool.js";

describe("parseMultitoolLock", () => {
  it("extracts tool names and sorted binary URLs", () => {
    const content = JSON.stringify({
      "$schema": "...",
      "buildifier": {
        "binaries": [
          { "kind": "file", "url": "https://example.com/buildifier-v1", "sha256": "abc", "os": "linux", "cpu": "arm64" },
        ],
      },
      "helm": {
        "binaries": [
          { "kind": "archive", "url": "https://example.com/helm-v1.tar.gz", "sha256": "def", "os": "linux", "cpu": "arm64" },
        ],
      },
    });
    const result = parseMultitoolLock(content);
    expect(result.size).toBe(2);
    expect(result.get("buildifier")).toBe("https://example.com/buildifier-v1");
    expect(result.get("helm")).toBe("https://example.com/helm-v1.tar.gz");
  });

  it("skips $schema key", () => {
    const content = JSON.stringify({ "$schema": "https://example.com/schema.json" });
    const result = parseMultitoolLock(content);
    expect(result.size).toBe(0);
  });

  it("sorts and joins all binary URLs when multiple platforms exist", () => {
    const content = JSON.stringify({
      "oras": {
        "binaries": [
          { "kind": "archive", "url": "https://example.com/oras-linux-arm64.tar.gz", "sha256": "a", "os": "linux", "cpu": "arm64" },
          { "kind": "archive", "url": "https://example.com/oras-linux-amd64.tar.gz", "sha256": "b", "os": "linux", "cpu": "x86_64" },
          { "kind": "archive", "url": "https://example.com/oras-darwin-arm64.tar.gz", "sha256": "c", "os": "macos", "cpu": "arm64" },
        ],
      },
    });
    const result = parseMultitoolLock(content);
    // URLs should be sorted alphabetically and joined with newlines
    expect(result.get("oras")).toBe(
      "https://example.com/oras-darwin-arm64.tar.gz\n" +
      "https://example.com/oras-linux-amd64.tar.gz\n" +
      "https://example.com/oras-linux-arm64.tar.gz"
    );
  });

  it("reordered binaries produce the same key (no false positive)", () => {
    const contentA = JSON.stringify({
      "tool": {
        "binaries": [
          { "url": "https://example.com/b", "sha256": "1" },
          { "url": "https://example.com/a", "sha256": "2" },
        ],
      },
    });
    const contentB = JSON.stringify({
      "tool": {
        "binaries": [
          { "url": "https://example.com/a", "sha256": "2" },
          { "url": "https://example.com/b", "sha256": "1" },
        ],
      },
    });
    const resultA = parseMultitoolLock(contentA);
    const resultB = parseMultitoolLock(contentB);
    expect(resultA.get("tool")).toBe(resultB.get("tool"));
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseMultitoolLock("not valid json");
    expect(result.size).toBe(0);
  });

  it("skips tools with empty binaries array", () => {
    const content = JSON.stringify({
      "empty-tool": { "binaries": [] },
      "good-tool": {
        "binaries": [
          { "kind": "file", "url": "https://example.com/good", "sha256": "x", "os": "linux", "cpu": "arm64" },
        ],
      },
    });
    const result = parseMultitoolLock(content);
    expect(result.size).toBe(1);
    expect(result.has("empty-tool")).toBe(false);
    expect(result.get("good-tool")).toBe("https://example.com/good");
  });

  it("skips tools with no binaries property", () => {
    const content = JSON.stringify({
      "no-binaries": {},
      "has-binaries": {
        "binaries": [
          { "kind": "file", "url": "https://example.com/bin", "sha256": "y", "os": "linux", "cpu": "arm64" },
        ],
      },
    });
    const result = parseMultitoolLock(content);
    expect(result.size).toBe(1);
    expect(result.has("no-binaries")).toBe(false);
  });
});

describe("findChangedTools", () => {
  it("detects new tools", () => {
    const head = new Map([["buildifier", "https://a.com/v2"], ["helm", "https://b.com/v1"]]);
    const base = new Map([["helm", "https://b.com/v1"]]);
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("buildifier");
    expect(deps[0].ecosystem).toBe("multitool");
    expect(deps[0].file).toBe("tools.json");
  });

  it("detects changed URLs (version bumps)", () => {
    const head = new Map([["helm", "https://b.com/v2"]]);
    const base = new Map([["helm", "https://b.com/v1"]]);
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("helm");
    expect(deps[0].version).toBe("https://b.com/v2");
  });

  it("skips unchanged tools", () => {
    const head = new Map([["helm", "https://b.com/v1"]]);
    const base = new Map([["helm", "https://b.com/v1"]]);
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(0);
  });

  it("detects all new tools when base is empty", () => {
    const head = new Map([
      ["buildifier", "https://a.com/v1"],
      ["helm", "https://b.com/v1"],
      ["oras", "https://c.com/v1"],
    ]);
    const base = new Map<string, string>();
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(3);
    expect(deps.map((d) => d.name).sort()).toEqual(["buildifier", "helm", "oras"]);
  });

  it("handles empty head (all tools removed)", () => {
    const head = new Map<string, string>();
    const base = new Map([["helm", "https://b.com/v1"]]);
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(0);
  });

  it("no change when binaries are reordered", () => {
    // Simulate parseMultitoolLock output (sorted+joined URLs)
    const urls = "https://a.com/darwin\nhttps://a.com/linux";
    const head = new Map([["tool", urls]]);
    const base = new Map([["tool", urls]]);
    const deps = findChangedTools(head, base, "tools.json");
    expect(deps).toHaveLength(0);
  });
});
