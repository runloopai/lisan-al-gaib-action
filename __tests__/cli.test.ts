import { describe, it, expect } from "vitest";
import { parseAndValidate, ValidationError, computeExitCode } from "../src/update/cli.js";
import type { RunResult } from "../src/update/run.js";

function baseOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pinUnpinned: true, ...overrides };
}

// ─── Ecosystem normalisation ────────────────────────────────────────────────

describe("parseAndValidate — ecosystem normalisation", () => {
  it("accepts a single ecosystem string", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts());
    expect(runOpts.ecosystems).toEqual(["docker"]);
  });

  it("accepts an array of ecosystem strings", () => {
    const { runOpts } = parseAndValidate(["docker", "rust"], baseOpts());
    expect(runOpts.ecosystems).toEqual(["docker", "rust"]);
  });

  it("splits comma-separated ecosystems in a single token", () => {
    const { runOpts } = parseAndValidate("actions,docker", baseOpts());
    expect(runOpts.ecosystems).toEqual(["actions", "docker"]);
  });

  it("deduplicates repeated ecosystems while preserving order", () => {
    const { runOpts } = parseAndValidate(["docker", "rust", "docker"], baseOpts());
    expect(runOpts.ecosystems).toEqual(["docker", "rust"]);
  });

  it("deduplicates across a comma list", () => {
    const { runOpts } = parseAndValidate("docker,rust,docker", baseOpts());
    expect(runOpts.ecosystems).toEqual(["docker", "rust"]);
  });

  it("throws ValidationError for an unknown ecosystem", () => {
    expect(() => parseAndValidate("bogus", baseOpts()))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("bogus", baseOpts()))
      .toThrow("Unknown ecosystem(s): bogus");
  });

  it("lists all unknown ecosystems in the error message", () => {
    expect(() => parseAndValidate(["docker", "nope", "nah"], baseOpts()))
      .toThrow("Unknown ecosystem(s): nope, nah");
  });
});

// ─── --mode ────────────────────────────────────────────────────────────────

describe("parseAndValidate — --mode", () => {
  it("defaults to major when omitted", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts());
    expect(runOpts.mode).toBe("major");
  });

  it("accepts major / minor / patch", () => {
    for (const mode of ["major", "minor", "patch"]) {
      const { runOpts } = parseAndValidate("docker", baseOpts({ mode }));
      expect(runOpts.mode).toBe(mode);
    }
  });

  it("throws ValidationError for an unknown mode", () => {
    expect(() => parseAndValidate("docker", baseOpts({ mode: "latest" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ mode: "latest" })))
      .toThrow("Invalid --mode value: latest");
  });
});

// ─── --style ───────────────────────────────────────────────────────────────

describe("parseAndValidate — --style", () => {
  it("defaults to sha when omitted", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts());
    expect(runOpts.style).toBe("sha");
  });

  it("accepts sha / preserve", () => {
    for (const style of ["sha", "preserve"]) {
      const { runOpts } = parseAndValidate("docker", baseOpts({ style }));
      expect(runOpts.style).toBe(style);
    }
  });

  it("throws ValidationError for an unknown style", () => {
    expect(() => parseAndValidate("docker", baseOpts({ style: "tag" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ style: "tag" })))
      .toThrow("Invalid --style value: tag");
  });
});

// ─── --allow-downgrade ──────────────────────────────────────────────────────

describe("parseAndValidate — --allow-downgrade", () => {
  it("defaults to no when omitted", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts());
    expect(runOpts.allowDowngrade).toBe("no");
  });

  it("accepts no / allow / only", () => {
    for (const v of ["no", "allow", "only"]) {
      const { runOpts } = parseAndValidate("docker", baseOpts({ allowDowngrade: v }));
      expect(runOpts.allowDowngrade).toBe(v);
    }
  });

  it("throws ValidationError for an unknown policy", () => {
    expect(() => parseAndValidate("docker", baseOpts({ allowDowngrade: "yes" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ allowDowngrade: "yes" })))
      .toThrow("Invalid --allow-downgrade value: yes");
  });
});

// ─── --license-policy ───────────────────────────────────────────────────────

describe("parseAndValidate — --license-policy", () => {
  it("defaults to block when omitted", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts());
    expect(runOpts.licensePolicy).toBe("block");
  });

  it("accepts block / warn / off", () => {
    for (const v of ["block", "warn", "off"]) {
      const { runOpts } = parseAndValidate("docker", baseOpts({ licensePolicy: v }));
      expect(runOpts.licensePolicy).toBe(v);
    }
  });

  it("throws ValidationError for an unknown policy", () => {
    expect(() => parseAndValidate("docker", baseOpts({ licensePolicy: "ignore" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ licensePolicy: "ignore" })))
      .toThrow("Invalid --license-policy value: ignore");
  });
});

// ─── --min-age ──────────────────────────────────────────────────────────────

describe("parseAndValidate — --min-age", () => {
  it("accepts 0", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts({ minAge: "0" }));
    expect(runOpts.minAgeDays).toBe(0);
  });

  it("accepts a positive integer", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts({ minAge: "14" }));
    expect(runOpts.minAgeDays).toBe(14);
  });

  it("throws ValidationError for a negative integer string (-1)", () => {
    // Negative numbers fail the /^\d+$/ check (the '-' is not a digit).
    expect(() => parseAndValidate("docker", baseOpts({ minAge: "-1" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ minAge: "-1" })))
      .toThrow("Invalid --min-age value");
  });

  it("throws ValidationError for a float (1.5)", () => {
    expect(() => parseAndValidate("docker", baseOpts({ minAge: "1.5" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ minAge: "1.5" })))
      .toThrow("Invalid --min-age value");
  });

  it("throws ValidationError for NaN-string", () => {
    expect(() => parseAndValidate("docker", baseOpts({ minAge: "NaN" })))
      .toThrow(ValidationError);
  });

  it("throws ValidationError for a value exceeding Number.MAX_SAFE_INTEGER", () => {
    const huge = String(Number.MAX_SAFE_INTEGER + 1);
    expect(() => parseAndValidate("docker", baseOpts({ minAge: huge })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ minAge: huge })))
      .toThrow("Value exceeds Number.MAX_SAFE_INTEGER");
  });
});

// ─── --exclude ──────────────────────────────────────────────────────────────

describe("parseAndValidate — --exclude", () => {
  it("accepts a valid regex pattern", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts({ exclude: "^lodash" }));
    expect(runOpts.exclude).toHaveLength(1);
    expect(runOpts.exclude[0]).toBeInstanceOf(RegExp);
    expect("lodash".match(runOpts.exclude[0])).not.toBeNull();
  });

  it("accepts an array of valid regex patterns", () => {
    const { runOpts } = parseAndValidate("docker", baseOpts({ exclude: ["^alpine", "^nginx"] }));
    expect(runOpts.exclude).toHaveLength(2);
  });

  it("throws ValidationError for a malformed regex pattern", () => {
    expect(() => parseAndValidate("docker", baseOpts({ exclude: "(" })))
      .toThrow(ValidationError);
    expect(() => parseAndValidate("docker", baseOpts({ exclude: "(" })))
      .toThrow("Invalid --exclude pattern: (");
  });

  it("throws ValidationError for any malformed pattern in an array", () => {
    expect(() => parseAndValidate("docker", baseOpts({ exclude: ["^ok", "[unclosed"] })))
      .toThrow(ValidationError);
  });
});

// ─── --json / --dry-run ─────────────────────────────────────────────────────

describe("parseAndValidate — isJson / isDryRun flags", () => {
  it("isJson=false, isDryRun=false when neither flag given", () => {
    const { isJson, isDryRun } = parseAndValidate("docker", baseOpts());
    expect(isJson).toBe(false);
    expect(isDryRun).toBe(false);
  });

  it("isDryRun=true when --dry-run is set (isJson stays false)", () => {
    const { isJson, isDryRun } = parseAndValidate("docker", baseOpts({ dryRun: true }));
    expect(isJson).toBe(false);
    expect(isDryRun).toBe(true);
  });

  it("isJson=true implies isDryRun=true", () => {
    const { isJson, isDryRun } = parseAndValidate("docker", baseOpts({ json: true }));
    expect(isJson).toBe(true);
    expect(isDryRun).toBe(true);
  });

  it("jsonYesWarning=true when --json and --yes are both set", () => {
    const { jsonYesWarning } = parseAndValidate("docker", baseOpts({ json: true, yes: true }));
    expect(jsonYesWarning).toBe(true);
  });

  it("jsonYesWarning=false when only --json (no --yes)", () => {
    const { jsonYesWarning } = parseAndValidate("docker", baseOpts({ json: true }));
    expect(jsonYesWarning).toBe(false);
  });
});

// ─── computeExitCode ────────────────────────────────────────────────────────

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    candidates: [],
    applied: [],
    skipped: [],
    failed: [],
    noEdits: [],
    ...overrides,
  };
}

describe("computeExitCode", () => {
  const dep = {
    ecosystem: "docker" as const,
    name: "nginx",
    file: "/Dockerfile",
    current: "1.0.0",
    position: {},
  };
  const candidate = {
    dep,
    latest: "1.1.0",
    updateLevel: "minor" as const,
    publishDate: null,
    ageDays: null,
    breaking: false,
    direction: "upgrade" as const,
  };

  it("failed=[], noEdits=[], yes=false, apply mode → 0", () => {
    expect(computeExitCode(makeResult(), false, false)).toBe(0);
  });

  it("failed=[dep], noEdits=[], yes=false, apply mode → 1 (failed always exits 1)", () => {
    expect(computeExitCode(makeResult({ failed: [candidate] }), false, false)).toBe(1);
  });

  // P2 regression: previously, an interactive user who selected only candidates that
  // legitimately produce no edits got a non-zero exit even though they made an informed
  // choice and saw the benign-skip warning. That rule now applies only under --yes.
  it("failed=[], noEdits=[dep], applied=[], yes=false, apply mode → 0 (interactive: all-selected-produced-no-edit is not a failure)", () => {
    expect(computeExitCode(makeResult({ noEdits: [candidate] }), false, false)).toBe(0);
  });

  it("failed=[], noEdits=[dep], yes=true, apply mode → 1 (--yes: no-edits is a failure)", () => {
    expect(computeExitCode(makeResult({ noEdits: [candidate] }), true, false)).toBe(1);
  });

  it("failed=[dep], noEdits=[dep], yes=false, apply mode → 1 (failed takes precedence)", () => {
    expect(computeExitCode(makeResult({ failed: [candidate], noEdits: [candidate] }), false, false)).toBe(1);
  });

  // Report-only exit-code regression (fix for --json/--dry-run + digestDropped):
  // In report-only modes the run() function places digestDropped candidates into `skipped`
  // (not `failed`), so that a mere unresolvable OCI digest does not cause exit 1 when
  // nothing was written or even attempted. Verify that computeExitCode exits 0 in this shape.
  it("failed=[], skipped=[digestDropped], noEdits=[], yes=false, apply mode → 0 (report-only mode: unresolvable digest is advisory)", () => {
    // This is the RunResult shape returned by run() in --json / --dry-run when a digest
    // could not be resolved. digestDropped goes to skipped, not failed.
    expect(computeExitCode(makeResult({ skipped: [candidate] }), false, false)).toBe(0);
  });

  // P1.1 regression: a non-JSON --dry-run preview where every selected candidate is a
  // benign no-op (e.g. a multi-line FROM, a template-incompatible version constant) must
  // not exit 1 — nothing was ever attempted, so noEdits is purely informational here.
  it("isDryRun=true, failed=[], applied=[], noEdits=[dep] → 0 (report-only mode never fails on noEdits)", () => {
    expect(computeExitCode(makeResult({ noEdits: [candidate] }), false, true)).toBe(0);
  });

  it("isDryRun=true, yes=true, failed=[], noEdits=[dep] → 0 (--yes --dry-run also never fails on noEdits)", () => {
    expect(computeExitCode(makeResult({ noEdits: [candidate] }), true, true)).toBe(0);
  });

  it("isDryRun=true, failed=[dep] → 1 (a hard failure still exits 1 even in report-only mode)", () => {
    expect(computeExitCode(makeResult({ failed: [candidate] }), false, true)).toBe(1);
  });
});
