import { describe, it, expect } from "vitest";
import { determineStatus, sortedByStatus, reportTotals } from "../src/report.js";
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

  it("preserves order within same status", () => {
    const input = [
      makeResult("fail", "b"),
      makeResult("fail", "a"),
    ];
    const sorted = sortedByStatus(input);
    expect(sorted.map((r) => r.dep.name)).toEqual(["b", "a"]);
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
