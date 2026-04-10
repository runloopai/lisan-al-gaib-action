import { describe, it, expect } from "vitest";
import { parseModuleLock } from "../src/ecosystems/bazel-module.js";

describe("parseModuleLock", () => {
  it("extracts module names and versions", () => {
    const content = JSON.stringify({
      lockFileVersion: 11,
      moduleDepGraph: {
        "rules_java@8.12.0": {
          name: "rules_java",
          version: "8.12.0",
        },
        "protobuf@29.3": {
          name: "protobuf",
          version: "29.3",
        },
      },
    });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(2);
    expect(modules.get("rules_java")).toBe("8.12.0");
    expect(modules.get("protobuf")).toBe("29.3");
  });

  it("skips root module entry (empty key)", () => {
    const content = JSON.stringify({
      moduleDepGraph: {
        "": { name: "", version: "0.0.0" },
        "rules_java@8.12.0": { name: "rules_java", version: "8.12.0" },
      },
    });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(1);
    expect(modules.has("")).toBe(false);
  });

  it("skips <root> key", () => {
    const content = JSON.stringify({
      moduleDepGraph: {
        "<root>": { name: "my_project", version: "0.0.0" },
        "abseil-cpp@20240722.0": { name: "abseil-cpp", version: "20240722.0" },
      },
    });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(1);
  });

  it("handles missing moduleDepGraph", () => {
    const content = JSON.stringify({ lockFileVersion: 11 });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(0);
  });

  it("handles malformed JSON", () => {
    const modules = parseModuleLock("not json");
    expect(modules.size).toBe(0);
  });

  it("handles empty moduleDepGraph", () => {
    const content = JSON.stringify({ moduleDepGraph: {} });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(0);
  });

  it("skips entries without name or version", () => {
    const content = JSON.stringify({
      moduleDepGraph: {
        "incomplete@1.0": { name: "incomplete" },
        "rules_java@8.12.0": { name: "rules_java", version: "8.12.0" },
      },
    });
    const modules = parseModuleLock(content);
    expect(modules.size).toBe(1);
  });
});
