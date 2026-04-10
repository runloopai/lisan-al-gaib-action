import * as core from "@actions/core";
import * as path from "node:path";
import type { CheckResult, DepStatus } from "./ecosystems/types.js";
import type { LicenseResult } from "./license.js";

export function determineStatus(
  ageDays: number | null,
  minAgeDays: number,
  warnAgeDays: number,
): DepStatus {
  if (ageDays === null) return "unknown";
  if (ageDays < minAgeDays) return "fail";
  if (ageDays < warnAgeDays) return "warn";
  return "pass";
}

interface RemediationHint {
  file: string;
  setting: string;
}

function getRemediationHint(
  dep: { ecosystem: string; file: string },
  minAgeDays: number,
): RemediationHint | null {
  if (dep.ecosystem === "python") {
    return {
      file: "pyproject.toml",
      setting: `[tool.uv]\nexclude-newer = "${minAgeDays} days"`,
    };
  }

  if (dep.ecosystem !== "npm") return null;

  const base = path.basename(dep.file);
  if (base === "pnpm-lock.yaml") {
    return {
      file: "pnpm-workspace.yaml",
      setting: `minimumReleaseAge: ${minAgeDays * 24 * 60}  # ${minAgeDays} days, in minutes`,
    };
  }
  if (base === "yarn.lock") {
    return {
      file: ".yarnrc.yml",
      setting: `npmMinimalAgeGate: "${minAgeDays}d"`,
    };
  }
  if (base === "bun.lock" || base === "bun.lockb") {
    return {
      file: "bunfig.toml",
      setting: `[install]\nminimumReleaseAge = ${minAgeDays * 24 * 60 * 60}  # ${minAgeDays} days, in seconds`,
    };
  }
  // npm (package-lock.json) — no native support yet
  return null;
}

export function emitAnnotations(results: CheckResult[], minAgeDays: number): void {
  // Collect unique remediation hints per lockfile
  const hintsByFile = new Map<string, RemediationHint>();

  for (const { dep, ageDays, status } of results) {
    if (status === "fail") {
      core.error(
        `${dep.name}@${dep.version} published ${ageDays}d ago, minimum is ${minAgeDays}d`,
        { file: dep.file },
      );
      const hint = getRemediationHint(dep, minAgeDays);
      if (hint && !hintsByFile.has(hint.file)) {
        hintsByFile.set(hint.file, hint);
      }
    } else if (status === "warn") {
      core.warning(
        `${dep.name}@${dep.version} published ${ageDays}d ago`,
        { file: dep.file },
      );
    }
  }

  if (hintsByFile.size > 0) {
    core.info("");
    core.info("To prevent installing packages younger than the age gate at the package manager level:");
    for (const [, hint] of hintsByFile) {
      core.info(`  Add to ${hint.file}:`);
      for (const line of hint.setting.split("\n")) {
        core.info(`    ${line}`);
      }
    }
  }
}

const STATUS_ORDER: Record<DepStatus, number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
};

export function sortedByStatus(results: CheckResult[]): CheckResult[] {
  return [...results].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
}

export async function writeSummary(
  results: CheckResult[],
  minAgeDays: number,
  warnAgeDays: number,
  licenseResults: LicenseResult[] = [],
): Promise<void> {
  if (results.length === 0 && licenseResults.length === 0) {
    core.summary.addRaw("No dependency changes detected.");
    core.summary.addRaw(
      "\n\n---\nMade with 💚 by [Runloop AI](https://runloop.ai)\n",
    );
    await core.summary.write();
    return;
  }

  const statusIcon: Record<DepStatus, string> = {
    pass: "✅",
    warn: "⚠️",
    fail: "❌",
    unknown: "❓",
  };

  core.summary.addHeading("Dependency Age Check", 2);
  core.summary.addRaw(
    `Minimum age: **${minAgeDays}d** | Warning threshold: **${warnAgeDays}d**\n\n`,
  );

  core.summary.addTable([
    [
      { data: "Ecosystem", header: true },
      { data: "Package", header: true },
      { data: "Version", header: true },
      { data: "Age (days)", header: true },
      { data: "Status", header: true },
    ],
    ...sortedByStatus(results).map((r) => [
      r.dep.ecosystem,
      r.dep.name,
      r.dep.version,
      r.ageDays !== null ? String(r.ageDays) : "?",
      `${statusIcon[r.status]} ${r.status.toUpperCase()}`,
    ]),
  ]);

  // License compliance table
  if (licenseResults.length > 0) {
    core.summary.addHeading("License Compliance", 2);
    core.summary.addTable([
      [
        { data: "Ecosystem", header: true },
        { data: "Package", header: true },
        { data: "Version", header: true },
        { data: "License", header: true },
        { data: "Status", header: true },
      ],
      ...licenseResults.map((lr) => [
        lr.ecosystem,
        lr.name,
        lr.version,
        lr.spdx ?? lr.license ?? "?",
        lr.compatible === true
          ? "✅ OK"
          : lr.compatible === false
            ? "❌ INCOMPATIBLE"
            : "❓ UNKNOWN",
      ]),
    ]);
  }

  core.summary.addRaw(
    "\n\n---\nMade with 💚 by [Runloop AI](https://runloop.ai)\n",
  );

  await core.summary.write();
}

export function reportTotals(results: CheckResult[]): {
  checked: number;
  failures: number;
  warnings: number;
} {
  const checked = results.filter((r) => r.status !== "unknown").length;
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return { checked, failures, warnings };
}
