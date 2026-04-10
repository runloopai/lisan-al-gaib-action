import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  warning: vi.fn(),
}));

import * as core from "@actions/core";
import { getInputs } from "../src/inputs.js";

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
        "module-bazel-lock": "MODULE.bazel.lock",
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
    expect(inputs.moduleBazelLock).toBe("MODULE.bazel.lock");
    expect(inputs.allowedLicenses).toBe("auto");
  });
});
