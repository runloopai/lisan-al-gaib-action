import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  warning: vi.fn(),
}));

import * as core from "@actions/core";
import { getInputs, parseLicenseOverrides, parseAgeOverrides } from "../src/inputs.js";

describe("getInputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const defaults: Record<string, string> = {
        ecosystems: "npm",
        "min-age-days": "14",
        "warn-age-days": "21",
        "base-ref": "",
        "node-lockfiles": "",
        "python-lockfiles": "",
        "module-bazel": "MODULE.bazel",
        "workflow-files": "",
        "github-token": "tok",
        "bcr-url": "https://bcr.bazel.build",
        "npm-registry-url": "https://registry.npmjs.org",
        "pypi-registry-url": "https://pypi.org",
        "crates-registry-url": "https://crates.io",
        "maven-registry-url": "https://repo1.maven.org/maven2",
        "strict-third-party": "false",
        "bypass-keyword": "",
        "check-all-on-new-workflow": "true",
        "allowed-licenses": "auto",
      };
      return defaults[name] ?? "";
    });
    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === "check-all-on-new-workflow") return true;
      if (name === "strict-third-party") return false;
      return false;
    });
  });

  it("parses ecosystems list", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === "ecosystems") return "npm, python, rust";
      return "";
    });
    vi.mocked(core.getBooleanInput).mockReturnValue(false);
    const inputs = getInputs();
    expect(inputs.ecosystems).toEqual(["npm", "python", "rust"]);
  });

  it("parses numeric inputs", () => {
    const inputs = getInputs();
    expect(inputs.minAgeDays).toBe(14);
    expect(inputs.warnAgeDays).toBe(21);
  });

  it("warns when warnAgeDays < minAgeDays", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === "ecosystems") return "npm";
      if (name === "min-age-days") return "30";
      if (name === "warn-age-days") return "14";
      return "";
    });
    vi.mocked(core.getBooleanInput).mockReturnValue(false);
    getInputs();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("less than min-age-days"),
    );
  });

  it("trims trailing slashes from registry URLs", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === "ecosystems") return "npm";
      if (name === "npm-registry-url") return "https://registry.npmjs.org/";
      if (name === "bcr-url") return "https://bcr.bazel.build/";
      return "";
    });
    vi.mocked(core.getBooleanInput).mockReturnValue(false);
    const inputs = getInputs();
    expect(inputs.registries.npm).toBe("https://registry.npmjs.org");
    expect(inputs.bcrUrl).toBe("https://bcr.bazel.build");
  });

  it("uses defaults for empty optional inputs", () => {
    const inputs = getInputs();
    expect(inputs.moduleBazel).toBe("MODULE.bazel");
    expect(inputs.allowedLicenses).toBe("auto");
  });
});

describe("parseLicenseOverrides", () => {
  it("returns empty map for empty input", () => {
    expect(parseLicenseOverrides("").size).toBe(0);
  });

  it("parses nested YAML structure", () => {
    const input = `npm:
  lodash: MIT
  express: Apache-2.0
python:
  requests: Apache-2.0`;
    const result = parseLicenseOverrides(input);
    expect(result.size).toBe(2);
    expect(result.get("npm")?.get("lodash")).toBe("MIT");
    expect(result.get("npm")?.get("express")).toBe("Apache-2.0");
    expect(result.get("python")?.get("requests")).toBe("Apache-2.0");
  });

  it("skips non-string values", () => {
    const input = `npm:
  lodash: MIT
  bad: 123`;
    const result = parseLicenseOverrides(input);
    expect(result.get("npm")?.size).toBe(1);
  });

  it("handles malformed YAML gracefully", () => {
    const result = parseLicenseOverrides(":::invalid yaml[[[");
    expect(result.size).toBe(0);
  });

  it("skips ecosystem with no valid packages", () => {
    const input = `npm:
  bad: 123`;
    const result = parseLicenseOverrides(input);
    expect(result.size).toBe(0);
  });
});

describe("parseAgeOverrides", () => {
  it("returns empty map for empty input", () => {
    expect(parseAgeOverrides("").size).toBe(0);
  });

  it("parses array format", () => {
    const input = `npm:
  - lodash
  - express`;
    const result = parseAgeOverrides(input);
    expect(result.get("npm")?.has("lodash")).toBe(true);
    expect(result.get("npm")?.has("express")).toBe(true);
  });

  it("parses legacy object format", () => {
    const input = `npm:
  lodash: ignore
  express: ignore`;
    const result = parseAgeOverrides(input);
    expect(result.get("npm")?.has("lodash")).toBe(true);
    expect(result.get("npm")?.has("express")).toBe(true);
  });

  it("handles malformed YAML gracefully", () => {
    const result = parseAgeOverrides(":::bad");
    expect(result.size).toBe(0);
  });

  it("skips non-string array items", () => {
    const input = `npm:
  - lodash
  - 123`;
    const result = parseAgeOverrides(input);
    expect(result.get("npm")?.size).toBe(1);
  });
});
