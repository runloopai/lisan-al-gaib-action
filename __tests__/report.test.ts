import { describe, it, expect } from "vitest";
import { determineStatus, sortedByStatus, reportTotals, versionAtLeast, parseExcludeNewerDays } from "../src/report.js";
import type { CheckResult, DepStatus } from "../src/ecosystems/types.js";

function makeResult(status: DepStatus, name = "pkg"): CheckResult {
  return {
    dep: { ecosystem: "npm", name, version: "1.0.0", file: "pnpm-lock.yaml" },
    publishDate: null,
    ageDays: status === "fail" ? 5 : status === "warn" ? 15 : status === "unknown" ? null : 30,
    status,
  };
}

describe("determineStatus", () => {
  it("returns fail when age < minAgeDays", () => {
    expect(determineStatus(5, 14, 21)).toBe("fail");
  });

  it("returns warn when minAgeDays <= age < warnAgeDays", () => {
    expect(determineStatus(15, 14, 21)).toBe("warn");
  });

  it("returns pass when age >= warnAgeDays", () => {
    expect(determineStatus(30, 14, 21)).toBe("pass");
  });

  it("returns unknown when age is null", () => {
    expect(determineStatus(null, 14, 21)).toBe("unknown");
  });

  it("returns pass at exactly warnAgeDays", () => {
    expect(determineStatus(21, 14, 21)).toBe("pass");
  });

  it("returns warn at exactly minAgeDays", () => {
    expect(determineStatus(14, 14, 21)).toBe("warn");
  });

  it("returns fail at zero days", () => {
    expect(determineStatus(0, 14, 21)).toBe("fail");
  });
});

describe("sortedByStatus", () => {
  it("sorts fail first, then warn, unknown, pass", () => {
    const input = [
      makeResult("pass"),
      makeResult("unknown"),
      makeResult("fail"),
      makeResult("warn"),
    ];
    const sorted = sortedByStatus(input);
    expect(sorted.map((r) => r.status)).toEqual(["fail", "warn", "unknown", "pass"]);
  });

  it("sorts by name within same status", () => {
    const input = [
      makeResult("fail", "b"),
      makeResult("fail", "a"),
    ];
    const sorted = sortedByStatus(input);
    expect(sorted.map((r) => r.dep.name)).toEqual(["a", "b"]);
  });

  it("does not mutate original array", () => {
    const input = [makeResult("pass"), makeResult("fail")];
    sortedByStatus(input);
    expect(input[0].status).toBe("pass");
  });
});

describe("reportTotals", () => {
  it("counts failures and warnings", () => {
    const results = [
      makeResult("fail"),
      makeResult("fail"),
      makeResult("warn"),
      makeResult("pass"),
    ];
    const totals = reportTotals(results);
    expect(totals).toEqual({ checked: 4, failures: 2, warnings: 1 });
  });

  it("excludes unknown from checked count", () => {
    const results = [makeResult("unknown"), makeResult("pass")];
    const totals = reportTotals(results);
    expect(totals).toEqual({ checked: 1, failures: 0, warnings: 0 });
  });

  it("returns zeros for empty input", () => {
    expect(reportTotals([])).toEqual({ checked: 0, failures: 0, warnings: 0 });
  });
});

describe("versionAtLeast", () => {
  it("equal versions", () => {
    expect(versionAtLeast("1.2.3", "1.2.3")).toBe(true);
  });

  it("greater major", () => {
    expect(versionAtLeast("2.0.0", "1.9.9")).toBe(true);
  });

  it("lesser minor", () => {
    expect(versionAtLeast("1.0.0", "1.1.0")).toBe(false);
  });

  it("missing patch in actual", () => {
    expect(versionAtLeast("1.2", "1.2.0")).toBe(true);
    expect(versionAtLeast("1.2", "1.2.1")).toBe(false);
  });

  it("returns false for NaN segments", () => {
    expect(versionAtLeast("1.x.0", "1.0.0")).toBe(false);
  });
});

describe("parseExcludeNewerDays", () => {
  it("parses '14 days'", () => {
    expect(parseExcludeNewerDays("14 days")).toBe(14);
  });

  it("parses '1 day'", () => {
    expect(parseExcludeNewerDays("1 day")).toBe(1);
  });

  it("parses 'P14D'", () => {
    expect(parseExcludeNewerDays("P14D")).toBe(14);
  });

  it("parses RFC 3339 timestamp", () => {
    const daysAgo = 10;
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const result = parseExcludeNewerDays(ts);
    expect(result).toBeGreaterThanOrEqual(daysAgo - 1);
    expect(result).toBeLessThanOrEqual(daysAgo + 1);
  });

  it("returns null for garbage", () => {
    expect(parseExcludeNewerDays("not-a-date")).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(parseExcludeNewerDays("")).toBe(null);
  });
});
