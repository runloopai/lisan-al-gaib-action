import { describe, it, expect } from "vitest";
import { getAllowedLicenses, isLicenseCompatible } from "../src/license.js";

describe("getAllowedLicenses", () => {
  it("returns defaults for 'auto'", () => {
    const licenses = getAllowedLicenses("auto");
    expect(licenses).toContain("MIT");
    expect(licenses).toContain("Apache-2.0");
    expect(licenses).toContain("ISC");
  });

  it("returns defaults for empty string", () => {
    const licenses = getAllowedLicenses("");
    expect(licenses).toContain("MIT");
  });

  it("parses comma-separated list", () => {
    const licenses = getAllowedLicenses("MIT,Apache-2.0,GPL-3.0-only");
    expect(licenses).toEqual(["MIT", "Apache-2.0", "GPL-3.0-only"]);
  });

  it("trims whitespace", () => {
    const licenses = getAllowedLicenses(" MIT , ISC ");
    expect(licenses).toEqual(["MIT", "ISC"]);
  });
});

describe("isLicenseCompatible", () => {
  const allowed = ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"];

  it("accepts MIT against permissive list", () => {
    expect(isLicenseCompatible("MIT", allowed)).toBe(true);
  });

  it("rejects GPL against permissive list", () => {
    expect(isLicenseCompatible("GPL-3.0-only", allowed)).toBe(false);
  });

  it("handles spdx-correct normalization", () => {
    // "Apache 2.0" should be corrected to "Apache-2.0"
    expect(isLicenseCompatible("Apache 2.0", allowed)).toBe(true);
  });

  it("handles OR expressions", () => {
    // MIT OR GPL-3.0 — MIT is in the allowed list
    expect(isLicenseCompatible("MIT OR GPL-3.0-only", allowed)).toBe(true);
  });

  it("rejects completely unknown licenses via fallback", () => {
    expect(isLicenseCompatible("PROPRIETARY", allowed)).toBe(false);
  });

  it("accepts exact match for custom licenses", () => {
    expect(isLicenseCompatible("CUSTOM", ["CUSTOM"])).toBe(true);
  });
});
