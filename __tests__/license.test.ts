import { describe, it, expect } from "vitest";
import { isLicenseCompatible, isCompatibleWith, detectLicenseFromText, normalizeLicense } from "../src/license.js";

describe("isCompatibleWith", () => {
  it("permissive flows into everything", () => {
    expect(isCompatibleWith("MIT", "GPL-3.0-or-later")).toBe(true);
    expect(isCompatibleWith("MIT", "Apache-2.0")).toBe(true);
    expect(isCompatibleWith("ISC", "AGPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("BSD-3-Clause", "MIT")).toBe(true);
    expect(isCompatibleWith("0BSD", "GPL-2.0-only")).toBe(true);
  });

  it("Apache-2.0 is incompatible with GPL-2.0-only", () => {
    expect(isCompatibleWith("Apache-2.0", "GPL-2.0-only")).toBe(false);
  });

  it("Apache-2.0 is compatible with GPL-3.0", () => {
    expect(isCompatibleWith("Apache-2.0", "GPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("Apache-2.0", "GPL-3.0-or-later")).toBe(true);
  });

  it("GPL-3.0 does not flow into MIT", () => {
    expect(isCompatibleWith("GPL-3.0-only", "MIT")).toBe(false);
  });

  it("GPL-3.0 flows into GPL-3.0 and AGPL-3.0", () => {
    expect(isCompatibleWith("GPL-3.0-only", "GPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("GPL-3.0-only", "AGPL-3.0-only")).toBe(true);
  });

  it("GPL-2.0-only does not flow into GPL-3.0-only", () => {
    expect(isCompatibleWith("GPL-2.0-only", "GPL-3.0-only")).toBe(false);
  });

  it("GPL-2.0-or-later flows into GPL-3.0", () => {
    expect(isCompatibleWith("GPL-2.0-or-later", "GPL-3.0-only")).toBe(true);
  });

  it("AGPL-3.0 only flows into AGPL-3.0", () => {
    expect(isCompatibleWith("AGPL-3.0-only", "AGPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("AGPL-3.0-only", "GPL-3.0-only")).toBe(false);
    expect(isCompatibleWith("AGPL-3.0-only", "MIT")).toBe(false);
  });

  it("LGPL flows into GPL", () => {
    expect(isCompatibleWith("LGPL-2.1-only", "GPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("LGPL-3.0-only", "GPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("LGPL-3.0-only", "GPL-2.0-only")).toBe(false);
  });

  it("MPL-2.0 flows into GPL and permissive targets", () => {
    expect(isCompatibleWith("MPL-2.0", "GPL-3.0-only")).toBe(true);
    expect(isCompatibleWith("MPL-2.0", "MIT")).toBe(true);
    expect(isCompatibleWith("MPL-2.0", "Apache-2.0")).toBe(true);
  });

  it("file-level copyleft (CDDL, EPL) compatible with permissive targets", () => {
    expect(isCompatibleWith("CDDL-1.0", "MIT")).toBe(true);
    expect(isCompatibleWith("EPL-2.0", "Apache-2.0")).toBe(true);
    expect(isCompatibleWith("EPL-1.0", "MIT")).toBe(true);
  });

  it("unknown licenses fall back to spdx-satisfies or exact match", () => {
    expect(isCompatibleWith("CUSTOM", "CUSTOM")).toBe(true);
    expect(isCompatibleWith("CUSTOM", "MIT")).toBe(false);
  });
});

describe("isLicenseCompatible", () => {
  it("checks against multiple target licenses (any match)", () => {
    expect(isLicenseCompatible("MIT", ["GPL-3.0-or-later"])).toBe(true);
    expect(isLicenseCompatible("Apache-2.0", ["GPL-3.0-or-later"])).toBe(true);
  });

  it("handles spdx-correct normalization", () => {
    expect(isLicenseCompatible("Apache 2.0", ["GPL-3.0-or-later"])).toBe(true);
  });

  it("rejects incompatible copyleft", () => {
    expect(isLicenseCompatible("GPL-3.0-only", ["MIT"])).toBe(false);
  });

  it("accepts exact match for custom licenses", () => {
    expect(isLicenseCompatible("CUSTOM", ["CUSTOM"])).toBe(true);
  });

  it("handles OR compound expressions", () => {
    // "Apache-2.0 OR ISC OR MIT" — MIT is permissive, flows into GPL-3.0
    expect(isLicenseCompatible("Apache-2.0 OR ISC OR MIT", ["GPL-3.0-or-later"])).toBe(true);
  });

  it("handles OR where all alternatives are incompatible", () => {
    expect(isLicenseCompatible("GPL-3.0-only OR AGPL-3.0-only", ["MIT"])).toBe(false);
  });

  it("open-source accepts any known license category", () => {
    expect(isLicenseCompatible("MIT", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("GPL-3.0-only", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("AGPL-3.0-only", ["open-source"])).toBe(true);
  });

  it("open-source-no-network-copyleft rejects AGPL", () => {
    expect(isLicenseCompatible("MIT", ["open-source-no-network-copyleft"])).toBe(true);
    expect(isLicenseCompatible("GPL-3.0-only", ["open-source-no-network-copyleft"])).toBe(true);
    expect(isLicenseCompatible("AGPL-3.0-only", ["open-source-no-network-copyleft"])).toBe(false);
  });

  it("handles AND compound expressions (all must be compatible)", () => {
    // MPL-2.0 AND MIT — both are open-source
    expect(isLicenseCompatible("MPL-2.0 AND MIT", ["open-source"])).toBe(true);
    // Apache-2.0 AND MIT — both are permissive/compatible with GPL-3.0
    expect(isLicenseCompatible("Apache-2.0 AND MIT", ["GPL-3.0-or-later"])).toBe(true);
    // BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 — all permissive
    expect(isLicenseCompatible("BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0", ["open-source"])).toBe(true);
  });

  it("AND with incompatible component fails", () => {
    // GPL-3.0 AND MIT — GPL-3.0 is not compatible with MIT target
    expect(isLicenseCompatible("GPL-3.0-only AND MIT", ["MIT"])).toBe(false);
  });

  it("normalizes non-SPDX license strings", () => {
    expect(isLicenseCompatible("ISC License", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("ISC License (ISCL)", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("MIT-CMU", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("Public Domain", ["open-source"])).toBe(true);
    expect(isLicenseCompatible("Python Software Foundation License", ["open-source"])).toBe(true);
  });
});

describe("detectLicenseFromText", () => {
  it("returns null for short text", () => {
    expect(detectLicenseFromText("MIT")).toBe(null);
  });

  it("detects MIT via keyword fallback", () => {
    const text = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...";
    expect(detectLicenseFromText(text)).toBe("MIT");
  });

  it("detects Apache-2.0 via keyword fallback", () => {
    const text = "Apache License\nVersion 2.0\n\nLicensed under the Apache License...some more text to be long enough";
    expect(detectLicenseFromText(text)).toBe("Apache-2.0");
  });

  it("returns null for unrecognizable text", () => {
    const text = "This is some random text that is long enough to not be filtered but does not match any license pattern at all whatsoever.";
    expect(detectLicenseFromText(text)).toBe(null);
  });
});

describe("normalizeLicense", () => {
  it("normalizes ISC variants", () => {
    expect(normalizeLicense("ISC License")).toBe("ISC");
    expect(normalizeLicense("ISC License (ISCL)")).toBe("ISC");
    expect(normalizeLicense("ISC Licence")).toBe("ISC");
  });

  it("normalizes MIT variants", () => {
    expect(normalizeLicense("MIT License")).toBe("MIT");
    expect(normalizeLicense("MIT-CMU")).toBe("MIT");
  });

  it("normalizes public domain", () => {
    expect(normalizeLicense("Public Domain")).toBe("Unlicense");
  });

  it("normalizes BSD", () => {
    expect(normalizeLicense("BSD")).toBe("BSD-3-Clause");
    expect(normalizeLicense("BSD License")).toBe("BSD-3-Clause");
  });

  it("passes through unknown licenses", () => {
    expect(normalizeLicense("CustomLicense")).toBe("CustomLicense");
  });
});
