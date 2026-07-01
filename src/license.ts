import * as core from "@actions/core";
import { dedupeAndResolve } from "./update/resolve.js";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import spdxCorrect from "spdx-correct";
import spdxSatisfies from "spdx-satisfies";
import spdxParse from "spdx-expression-parse";
import { XMLParser } from "fast-xml-parser";
import spdxOsiJson from "spdx-osi/index.json" with { type: "json" };
import yaml from "js-yaml";
import spdxLicenseTexts from "./spdx-license-texts.json" with { type: "json" };
import tar from "tar-stream";
import type { RegistryUrls, LicenseOverrides } from "./inputs.js";
import type { CheckResult, ParsedImageRef } from "./ecosystems/types.js";
import { fetchImageLabels } from "./registry.js";
import { fetchWithRetry, FETCH_TIMEOUT_MS } from "./http.js";

/**
 * Thrown by license sub-fetchers when a registry call fails transiently
 * (HTTP 429 / 5xx / network timeout) to distinguish "license unavailable due
 * to registry error" from "no license declared" (null return).
 *
 * applyLicensePolicy catches this and marks the candidate's new-license fetch
 * as failed so --license-policy=block can fail closed instead of promoting an
 * update whose license cannot be confirmed.
 */
export class LicenseFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseFetchError";
  }
}

/** Quote a string for YAML if needed, using js-yaml's serializer. */
function yamlQuote(s: string): string {
  return yaml.dump(s, { flowLevel: 0 }).trimEnd();
}

/** Show a diff wrapped in a named group. */
async function showGroupedDiff(filePath: string, original: string, modified: string, groupName: string): Promise<boolean> {
  if (original === modified) return false;
  try {
    core.startGroup(groupName);
    await fs.writeFile(filePath, modified, "utf8");
    await exec.exec("git", ["diff", "-u", "--color", filePath], { silent: false });
    core.endGroup();
    return true;
  } finally {
    await fs.writeFile(filePath, original, "utf8");
  }
}

export type TargetLicenseMap = Map<string, string[]>;

export interface LicenseResult {
  name: string;
  version: string;
  ecosystem: string;
  license: string | null;
  spdx: string | null;
  compatible: boolean | null; // null = could not determine
}

/**
 * Detect the project's SPDX license from the repository's package.json or LICENSE file.
 */
export async function detectProjectLicense(): Promise<string | null> {
  // Try package.json first
  try {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
    if (typeof pkg.license === "string") {
      const corrected = spdxCorrect(pkg.license);
      if (corrected) return corrected;
    }
  } catch {
    // no package.json or no license field
  }

  // Try LICENSE file
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"]) {
    try {
      const content = await fs.readFile(name, "utf8");
      return detectLicenseFromText(content);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Compute bigrams for Dice coefficient similarity.
 */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bi = s.slice(i, i + 2);
    m.set(bi, (m.get(bi) ?? 0) + 1);
  }
  return m;
}

/**
 * Sørensen–Dice coefficient between two strings (0..1).
 */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const biA = bigrams(a);
  const biB = bigrams(b);
  let intersection = 0;
  for (const [bi, count] of biA) {
    intersection += Math.min(count, biB.get(bi) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

/**
 * Precomputed normalized license texts from spdx-license-list.
 * Only includes common licenses to avoid false positives and keep perf reasonable.
 */
const COMMON_SPDX_IDS = [
  "MIT", "Apache-2.0", "GPL-2.0-only", "GPL-2.0-or-later",
  "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later",
  "LGPL-3.0-only", "LGPL-3.0-or-later", "BSD-2-Clause", "BSD-3-Clause",
  "ISC", "MPL-2.0", "CDDL-1.0", "CDDL-1.1", "EPL-1.0", "EPL-2.0",
  "Unlicense", "0BSD", "Artistic-2.0", "Zlib", "BSL-1.0",
  "AGPL-3.0-only", "AGPL-3.0-or-later", "CC0-1.0", "PSF-2.0", "ZPL-2.0", "ZPL-2.1",
];

interface SpdxLicenseEntry {
  name: string;
  licenseText: string;
  osiApproved: boolean;
}

const licenseCorpus: Array<{ id: string; normalized: string }> = [];
for (const id of COMMON_SPDX_IDS) {
  const entry = (spdxLicenseTexts as unknown as Record<string, SpdxLicenseEntry>)[id];
  if (entry?.licenseText) {
    const normalized = entry.licenseText
      .toLowerCase()
      .replace(/copyright\s*(\(c\))?\s*\d{4}[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    licenseCorpus.push({ id, normalized });
  }
}

/**
 * Detect a license from raw LICENSE file text using spdx-license-list corpus
 * and Dice coefficient similarity matching, with keyword fallback for
 * non-standard license files that embed standard license text.
 */
export function detectLicenseFromText(text: string): string | null {
  if (text.length < 20) return null;

  // 1. Check preamble for SPDX expressions (handles dual/multi-license files)
  //    e.g., "dual [Apache-2.0] OR [GPL-2.0-or-later]" or "SPDX-License-Identifier: MIT"
  const preamble = text.slice(0, Math.min(text.length, 1000));
  const spdxIdMatch = preamble.match(/SPDX-License-Identifier:\s*([^\n]+)/i);
  if (spdxIdMatch) {
    const expr = spdxIdMatch[1].trim();
    const corrected = spdxCorrect(expr);
    if (corrected) return corrected;
    return expr;
  }

  // Check for explicit dual-license preamble with SPDX IDs
  // Handles formats like:
  //   "dual [Apache-2.0](url) OR [GPL-2.0-or-later](url) license"
  //   "dual licensed under Apache-2.0 or MIT"
  const spdxInPreamble = [...preamble.matchAll(
    /\b((?:Apache|MIT|BSD|GPL|LGPL|MPL|ISC|CC0|CDDL|EPL|Artistic|Unlicense|Zlib|BSL)[-\w]+(?:\.\d+)?[-\w]*)/gi,
  )].map((m) => m[1]).filter((s) => !s.endsWith(".html") && !s.endsWith(".txt"));
  const uniqueSpdx = [...new Set(spdxInPreamble)];
  if (
    uniqueSpdx.length >= 2 &&
    /\b(?:dual|double|either)\b/i.test(preamble) &&
    /\b(?:OR|\/)\b/i.test(preamble)
  ) {
    const a = spdxCorrect(uniqueSpdx[0]) ?? uniqueSpdx[0];
    const b = spdxCorrect(uniqueSpdx[1]) ?? uniqueSpdx[1];
    return `${a} OR ${b}`;
  }

  // 2. For reasonably-sized files, try Dice coefficient matching
  const normalized = text
    .toLowerCase()
    .replace(/copyright\s*(\(c\))?\s*\d{4}[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Only use Dice for files that are plausibly a single license (< 5KB normalized)
  if (normalized.length < 5000) {
    let bestId: string | null = null;
    let bestScore = 0;

    for (const { id, normalized: ref } of licenseCorpus) {
      const score = diceCoefficient(normalized, ref);
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (bestScore >= 0.8) return bestId;
  }

  // 3. Fall back to keyword detection for files that embed license text in preamble
  const upper = text.toUpperCase();
  if (upper.includes("MIT LICENSE") || upper.includes("PERMISSION IS HEREBY GRANTED, FREE OF CHARGE")) {
    return "MIT";
  }
  if (upper.includes("APACHE LICENSE") && upper.includes("VERSION 2.0")) {
    return "Apache-2.0";
  }
  if (upper.includes("GNU GENERAL PUBLIC LICENSE") && upper.includes("VERSION 3")) {
    return "GPL-3.0-only";
  }
  if (upper.includes("GNU GENERAL PUBLIC LICENSE") && upper.includes("VERSION 2")) {
    return "GPL-2.0-only";
  }
  if (upper.includes("BSD 3-CLAUSE") || (upper.includes("BSD") && upper.includes("THREE CLAUSE"))) {
    return "BSD-3-Clause";
  }
  if (upper.includes("BSD 2-CLAUSE") || (upper.includes("BSD") && upper.includes("TWO CLAUSE")) || upper.includes("SIMPLIFIED BSD")) {
    return "BSD-2-Clause";
  }
  if (upper.includes("ISC LICENSE")) {
    return "ISC";
  }
  if (upper.includes("MOZILLA PUBLIC LICENSE") && upper.includes("VERSION 2.0")) {
    return "MPL-2.0";
  }
  if (upper.includes("UNLICENSE") || upper.includes("UNLICENCE")) {
    return "Unlicense";
  }
  return null;
}

/**
 * Normalize non-standard license strings to SPDX identifiers.
 * This handles cases where spdxCorrect() fails but we know what the license is.
 */
export function normalizeLicense(raw: string): string {
  const lower = raw.toLowerCase().trim();

  // ISC variants
  if (lower === "isc license" || lower === "isc license (iscl)" || lower === "isc licence") return "ISC";

  // MIT variants
  if (lower === "mit license" || lower === "mit licence") return "MIT";
  if (lower === "mit-cmu" || lower === "mit cmu") return "MIT";

  // Python / PSF
  if (lower.includes("python software foundation")) return "PSF-2.0";

  // Public domain
  if (lower === "public domain" || lower === "public-domain") return "Unlicense";

  // BSD variants
  if (lower === "bsd" || lower === "bsd license") return "BSD-3-Clause";

  // EDL 1.0 (Eclipse Distribution License) is BSD-3-Clause
  if (lower === "edl 1.0" || lower === "edl-1.0" || lower.includes("eclipse distribution license")) return "BSD-3-Clause";

  // CDDL variants
  if (lower === "cddl 1.0") return "CDDL-1.0";
  if (lower === "cddl 1.1") return "CDDL-1.1";

  // CDDL + GPL with classpath exception (javax.* artifacts)
  // The classpath exception makes GPL-2.0 effectively permissive for library consumers
  if (lower.includes("cddl") && lower.includes("gpl") && lower.includes("classpath")) {
    return "CDDL-1.0 OR GPL-2.0-only WITH Classpath-exception-2.0";
  }
  if (lower === "cddl/gplv2+ce" || lower === "cddl+gpl" || lower === "cddl + gpl") {
    return "CDDL-1.0 OR GPL-2.0-only WITH Classpath-exception-2.0";
  }

  // EPL variants
  if (lower === "epl 1.0" || lower === "eclipse public license 1.0") return "EPL-1.0";
  if (lower === "epl 2.0" || lower === "eclipse public license 2.0") return "EPL-2.0";

  // ZPL (Zope Public License) — permissive
  if (lower === "zpl" || lower === "zpl 2.0" || lower === "zope public license") return "ZPL-2.0";
  if (lower === "zpl 2.1") return "ZPL-2.1";

  // GPL w/ Classpath Exception variants (common in Jakarta/javax POMs)
  if (((lower.includes("gpl") || lower.includes("general public license")) && lower.includes("classpath"))
    || lower === "gpl2 w/ cpe" || lower === "gplv2+ce") {
    return "GPL-2.0-only WITH Classpath-exception-2.0";
  }

  // Bouncy Castle Licence — MIT-style permissive
  if (lower.includes("bouncy castle")) return "MIT";

  // Go License — BSD-3-Clause
  if (lower === "go license") return "BSD-3-Clause";

  // Dual License (python-dateutil is Apache-2.0 OR BSD-3-Clause)
  if (lower === "dual license" || lower === "dual licence") return "Apache-2.0 OR BSD-3-Clause";

  // Detect PSF/matplotlib-style license texts that spdxCorrect misidentifies
  if (lower.includes("matplotlib") && lower.includes("license agreement")) return "PSF-2.0";

  return raw;
}

/**
 * Try to detect a license from a PyPI package description/README.
 * Looks for patterns like "## License\n\nMIT" or "License: Apache-2.0".
 */
function detectLicenseFromDescription(text: string): string | null {
  // Look for "## License" heading followed by a license name
  const headingMatch = text.match(/#+\s*Licen[sc]e\s*\n+\s*([^\n]+)/i);
  if (headingMatch) {
    const line = headingMatch[1].trim();
    // Check for common SPDX-like identifiers in the line
    const corrected = spdxCorrect(line);
    if (corrected) return corrected;
    const normalized = normalizeLicense(line);
    if (normalized !== line) return normalized;
    // Try to detect from the line text
    const detected = detectLicenseFromText(line);
    if (detected) return detected;
  }
  // Look for "License: MIT" or "license: Apache-2.0" patterns
  const inlineMatch = text.match(/\bLicen[sc]e:\s*([^\n,]+)/i);
  if (inlineMatch) {
    const val = inlineMatch[1].trim().replace(/[.`*]/g, "");
    const corrected = spdxCorrect(val);
    if (corrected) return corrected;
    const normalized = normalizeLicense(val);
    if (normalized !== val) return normalized;
  }
  return null;
}

// OSI-approved licenses (from spdx-osi) plus additional well-known open-source licenses
const OSI_SET: ReadonlySet<string> = new Set(spdxOsiJson as string[]);

/** Additional licenses that are open-source but not OSI-approved */
const EXTRA_OPEN_SOURCE = new Set([
  "Unlicense", "CC0-1.0", "WTFPL", "BlueOak-1.0.0",
  "CC-BY-3.0", "CC-BY-4.0", "PSF-2.0", "Python-2.0", "Python-2.0.1",
  "CNRI-Python", "CNRI-Python-GPL-Compatible",
  "CDLA-Permissive-2.0", "MIT-CMU",
  "CDDL-1.1",
]);

/** Is this a recognized open-source SPDX identifier? */
function isOpenSource(spdx: string): boolean {
  return OSI_SET.has(spdx) || EXTRA_OPEN_SOURCE.has(spdx);
}

/** Is this an AGPL (network copyleft) license? */
function isNetworkCopyleft(spdx: string): boolean {
  return spdx.toUpperCase().startsWith("AGPL-");
}

function isStrongCopyleft(spdx: string): boolean {
  const upper = spdx.toUpperCase();
  return upper.startsWith("GPL-") || upper.startsWith("AGPL-");
}

/** Is this a relinkable copyleft license (LGPL, GPL, AGPL)?
 * These require the combined work to permit relinking with modified
 * versions of the library (LGPL) or to be open-sourced entirely (GPL/AGPL).
 * Excludes file-level copyleft like MPL, CDDL, EPL which only require
 * changes to the licensed files themselves to be shared. */
function isRelinkableCopyleft(spdx: string): boolean {
  const upper = spdx.toUpperCase();
  return upper.startsWith("LGPL-") || upper.startsWith("GPL-") || upper.startsWith("AGPL-");
}

// Permissive licenses for directional compatibility matrix
const PERMISSIVE = new Set([
  "MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "Unlicense", "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0",
  "Zlib", "WTFPL", "BlueOak-1.0.0", "Python-2.0", "PSF-2.0",
  "CNRI-Python", "MIT-CMU", "CDLA-Permissive-2.0", "ZPL-2.0", "ZPL-2.1",
]);

type LicenseCategory =
  | "permissive"
  | "apache-2.0"
  | "lgpl-2.0" | "lgpl-2.1" | "lgpl-3.0"
  | "mpl-2.0" | "epl-1.0" | "epl-2.0"
  | "cddl-1.0"
  | "gpl-2.0-only" | "gpl-2.0-or-later"
  | "gpl-3.0-only" | "gpl-3.0-or-later"
  | "agpl-3.0"
  | "unknown";

function categorize(spdx: string): LicenseCategory {
  const upper = spdx.toUpperCase();
  if (PERMISSIVE.has(spdx)) return "permissive";
  if (upper === "APACHE-2.0") return "apache-2.0";
  if (upper === "LGPL-2.0-ONLY" || upper === "LGPL-2.0-OR-LATER") return "lgpl-2.0";
  if (upper === "LGPL-2.1-ONLY" || upper === "LGPL-2.1-OR-LATER") return "lgpl-2.1";
  if (upper === "LGPL-3.0-ONLY" || upper === "LGPL-3.0-OR-LATER") return "lgpl-3.0";
  if (upper === "MPL-2.0" || upper === "MPL-2.0-NO-COPYLEFT-EXCEPTION") return "mpl-2.0";
  if (upper === "EPL-1.0") return "epl-1.0";
  if (upper === "EPL-2.0") return "epl-2.0";
  if (upper === "CDDL-1.0" || upper === "CDDL-1.1") return "cddl-1.0";
  if (upper === "GPL-2.0-ONLY") return "gpl-2.0-only";
  if (upper === "GPL-2.0-OR-LATER") return "gpl-2.0-or-later";
  if (upper === "GPL-3.0-ONLY") return "gpl-3.0-only";
  if (upper === "GPL-3.0-OR-LATER") return "gpl-3.0-or-later";
  if (upper.startsWith("AGPL-3.0")) return "agpl-3.0";
  return "unknown";
}

/**
 * Can code under `depLicense` be incorporated into a project under `targetLicense`?
 */
export function isCompatibleWith(
  depLicense: string,
  targetLicense: string,
): boolean {
  // Handle OR expressions first: dep is compatible if ANY alternative is compatible
  if (depLicense.includes(" OR ")) {
    const alternatives = depLicense.split(" OR ").map((s) => s.trim());
    return alternatives.some((alt) => isCompatibleWith(alt, targetLicense));
  }

  // GPL with Classpath Exception is effectively permissive for library consumers
  if (depLicense.includes("WITH Classpath-exception")) return true;

  // Special target aliases — use spdx-osi for robust identification
  if (targetLicense === "open-source") {
    return isOpenSource(depLicense);
  }
  if (targetLicense === "open-source-no-network-copyleft") {
    return isOpenSource(depLicense) && !isNetworkCopyleft(depLicense);
  }
  if (targetLicense === "open-source-no-strong-copyleft") {
    return isOpenSource(depLicense) && !isStrongCopyleft(depLicense);
  }
  if (targetLicense === "open-source-no-relinkable-copyleft") {
    return isOpenSource(depLicense) && !isRelinkableCopyleft(depLicense);
  }

  const depCat = categorize(depLicense);
  const targetCat = categorize(targetLicense);

  // Permissive flows into everything — check before unknown fallback
  if (depCat === "permissive") return true;

  // Apache-2.0 flows into everything except GPL-2.0-only
  if (depCat === "apache-2.0") {
    return targetCat !== "gpl-2.0-only";
  }

  // File-level copyleft (MPL, CDDL, EPL) is compatible with permissive targets.
  // These licenses only require changes to the licensed files themselves to be
  // shared — they don't impose restrictions on the consuming project's license.
  if (
    (depCat === "mpl-2.0" || depCat === "epl-1.0" || depCat === "epl-2.0" || depCat === "cddl-1.0") &&
    (targetCat === "permissive" || targetCat === "apache-2.0")
  ) {
    return true;
  }

  if (depCat === "unknown" || targetCat === "unknown") {
    // Fall back to spdx-satisfies or exact match
    return fallbackCheck(depLicense, targetLicense);
  }

  // Weak copyleft (LGPL, MPL, EPL) — can flow into GPL/AGPL of matching+ version
  if (depCat === "lgpl-2.0" || depCat === "lgpl-2.1") {
    return [
      depCat, "gpl-2.0-only", "gpl-2.0-or-later",
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  if (depCat === "lgpl-3.0") {
    return [
      "lgpl-3.0", "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  if (depCat === "mpl-2.0") {
    return [
      "mpl-2.0", "gpl-2.0-only", "gpl-2.0-or-later",
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  if (depCat === "epl-1.0") {
    // EPL-1.0 is weak copyleft (file-level); compatible with EPL, MPL, and GPL targets
    return [
      "epl-1.0", "epl-2.0", "mpl-2.0",
      "gpl-2.0-only", "gpl-2.0-or-later",
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  if (depCat === "epl-2.0") {
    return [
      "epl-2.0", "mpl-2.0",
      "gpl-2.0-only", "gpl-2.0-or-later",
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  // CDDL is weak copyleft (file-level); compatible with CDDL, MPL targets
  if (depCat === "cddl-1.0") {
    return ["cddl-1.0", "mpl-2.0"].includes(targetCat);
  }

  // GPL-2.0-only → GPL-2.0, GPL-2.0-or-later
  if (depCat === "gpl-2.0-only") {
    return ["gpl-2.0-only", "gpl-2.0-or-later"].includes(targetCat);
  }
  // GPL-2.0-or-later → GPL-2.0+, GPL-3.0+, AGPL-3.0
  if (depCat === "gpl-2.0-or-later") {
    return [
      "gpl-2.0-only", "gpl-2.0-or-later",
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  // GPL-3.0 → GPL-3.0, AGPL-3.0
  if (depCat === "gpl-3.0-only" || depCat === "gpl-3.0-or-later") {
    return [
      "gpl-3.0-only", "gpl-3.0-or-later", "agpl-3.0",
    ].includes(targetCat);
  }
  // AGPL-3.0 → AGPL-3.0 only
  if (depCat === "agpl-3.0") {
    return targetCat === "agpl-3.0";
  }

  return false;
}

// Numeric restrictiveness levels used by isLicenseMoreRestrictiveThan.
// Lower = more permissive. "unknown" is deliberately excluded from the key type (handled
// by callers as fail-open) — every OTHER LicenseCategory member is required here by the
// `Record<Exclude<...>, number>` type, so adding a new category to the union without also
// giving it a level is a compile error, not a silent runtime drift.
const RESTRICTIVENESS_LEVEL: Record<Exclude<LicenseCategory, "unknown">, number> = {
  permissive: 0,
  "apache-2.0": 1,
  "lgpl-2.0": 2, "lgpl-2.1": 2, "lgpl-3.0": 2,
  "mpl-2.0": 2, "epl-1.0": 2, "epl-2.0": 2, "cddl-1.0": 2,
  "gpl-2.0-only": 3, "gpl-2.0-or-later": 3,
  "gpl-3.0-only": 3, "gpl-3.0-or-later": 3,
  "agpl-3.0": 4,
};

/**
 * Compute the effective restrictiveness level of a potentially compound SPDX
 * expression.
 *
 * This is a deliberately separate evaluator from `licenseLevel`/`licenseLevelFromNode`
 * below: that one walks a real `spdx-expression-parse` AST (handles parens, returns a
 * 3-bucket permissive/copyleft/unknown classification) but has no notion of *ordering*
 * between two arbitrary expressions, which `isLicenseMoreRestrictiveThan` needs. Rather
 * than extend the AST walker with a numeric-level return type used by only one caller,
 * this string-split evaluator gives `isLicenseMoreRestrictiveThan` its own minimal,
 * narrowly-scoped (and explicitly fail-open on parens, see below) ordering logic.
 *
 *   - `A OR B`  → most-permissive (minimum) level: the user can choose the least
 *                 restrictive alternative, so the combined requirement is the lowest.
 *   - `A AND B` → most-restrictive (maximum) level: both licenses must be honored,
 *                 so the combined requirement is the highest.
 *   - `A WITH X` → treated as the base identifier `A` (exception clauses don't
 *                  change the fundamental restriction category).
 *
 * SPDX operator precedence: AND binds tighter than OR (SPDX 2.x spec §10).
 * We therefore split on OR first (lowest precedence, outermost), then on AND
 * within each OR-clause (higher precedence, inner), then strip WITH at the leaf.
 *
 * Returns `undefined` when any component maps to "unknown", preserving the
 * existing fail-open contract for unrecognized licenses.
 *
 * Note: parenthesized sub-expressions (e.g. `(A OR B) AND C`) are not parsed;
 * they will contain residual `(`/`)` chars and typically categorize as "unknown",
 * which is fail-open (safe). Simple non-nested compound expressions are handled.
 */
function licenseLevelOrd(spdx: string): number | undefined {
  // OR has lower precedence than AND — split OR first (outermost operator).
  // `A OR B AND C` ≡ `A OR (B AND C)` per SPDX spec.
  if (spdx.includes(" OR ")) {
    const parts = spdx.split(" OR ").map((s) => s.trim());
    const levels = parts.map(licenseLevelOrd);
    if (levels.some((l) => l === undefined)) return undefined;
    return Math.min(...(levels as number[]));
  }

  // AND has higher precedence than OR — split next.
  if (spdx.includes(" AND ")) {
    const parts = spdx.split(" AND ").map((s) => s.trim());
    const levels = parts.map(licenseLevelOrd);
    if (levels.some((l) => l === undefined)) return undefined;
    return Math.max(...(levels as number[]));
  }

  // WITH clause at the leaf level: evaluate the base license only.
  const withIdx = spdx.indexOf(" WITH ");
  if (withIdx !== -1) return licenseLevelOrd(spdx.slice(0, withIdx).trim());

  const category = categorize(spdx);
  if (category === "unknown") return undefined;
  return RESTRICTIVENESS_LEVEL[category];
}

/**
 * Returns true when `newLicense` is strictly MORE restrictive than `currentLicense`
 * (e.g. newLicense=GPL-3.0-only, currentLicense=MIT → true; new→MIT, current→GPL → false).
 * Returns false (fail-open) when either license maps to "unknown".
 * Handles compound SPDX expressions (OR/AND/WITH): OR takes the most-permissive
 * level, AND takes the most-restrictive, WITH evaluates the base license.
 * Use this instead of isCompatibleWith when ordering permissiveness, not checking mixing.
 */
export function isLicenseMoreRestrictiveThan(
  newLicense: string,
  currentLicense: string,
): boolean {
  const newLevel = licenseLevelOrd(newLicense);
  const curLevel = licenseLevelOrd(currentLicense);
  if (newLevel === undefined || curLevel === undefined) return false;
  return newLevel > curLevel;
}

/**
 * Normalize a raw registry license string to a corrected SPDX identifier.
 * Returns null on null/empty input or if normalization throws.
 */
export function normalizeSpdxId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const n = normalizeLicense(raw);
    return spdxCorrect(n) ?? n;
  } catch {
    return null;
  }
}

function fallbackCheck(depLicense: string, targetLicense: string): boolean {
  // Try spdx-satisfies
  try {
    return spdxSatisfies(depLicense, [targetLicense]);
  } catch {
    // Exact match fallback
    return depLicense.toLowerCase() === targetLicense.toLowerCase();
  }
}

/**
 * Parse target licenses input. Supports:
 *   - "auto" → detect from project, apply to all ecosystems
 *   - Plain string "MIT,Apache-2.0" → apply to all ecosystems
 *   - YAML map: { "*": "Apache-2.0", rust: "Apache-2.0, MIT", npm: "MIT" }
 * Returns null if license checking should be skipped.
 */
export async function getTargetLicenses(input: string): Promise<TargetLicenseMap | null> {
  if (!input) return null;
  if (input.toLowerCase() === "auto") {
    const detected = await detectProjectLicense();
    if (detected) {
      core.info(`Auto-detected project license: ${detected}`);
      const map: TargetLicenseMap = new Map();
      map.set("*", [detected]);
      return map;
    }
    core.info(
      "Could not auto-detect project license; defaulting to open-source-no-relinkable-copyleft.",
    );
    const map: TargetLicenseMap = new Map();
    map.set("*", ["open-source-no-relinkable-copyleft"]);
    return map;
  }

  // Try parsing as YAML map
  // Quote bare * keys (YAML treats * as alias character)
  const sanitized = input.replace(/^\*:/gm, '"*":');
  try {
    const parsed = yaml.load(sanitized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: TargetLicenseMap = new Map();
      for (const [key, value] of Object.entries(parsed as Record<string, string>)) {
        if (typeof value === "string") {
          map.set(key, value.split(",").map((s) => s.trim()).filter(Boolean));
        }
      }
      if (map.size > 0) return map;
    }
  } catch {
    // Not valid YAML — treat as plain comma-separated string
  }

  // Plain comma-separated string → wildcard
  const licenses = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (licenses.length === 0) return null;
  const map: TargetLicenseMap = new Map();
  map.set("*", licenses);
  return map;
}

/**
 * Get the target licenses for a specific ecosystem from the map.
 */
export function getEcosystemTargetLicenses(
  map: TargetLicenseMap,
  ecosystem: string,
): string[] {
  return map.get(ecosystem) ?? map.get("*") ?? [];
}

/**
 * Evaluate an SPDX expression AST against target licenses.
 * - OR nodes: ANY branch being compatible → OK
 * - AND nodes: ALL branches must be compatible
 * - Leaf nodes: check single license compatibility
 */
function evaluateExpr(
  node: spdxParse.Info,
  targetLicenses: string[],
): boolean {
  if ("conjunction" in node) {
    if (node.conjunction === "or") {
      return evaluateExpr(node.left, targetLicenses) ||
        evaluateExpr(node.right, targetLicenses);
    }
    // "and" — all must be compatible
    return evaluateExpr(node.left, targetLicenses) &&
      evaluateExpr(node.right, targetLicenses);
  }

  // Leaf: single license (preserve WITH exception)
  let id = node.plus ? `${node.license}-or-later` : node.license;
  if ("exception" in node && node.exception) {
    id = `${id} WITH ${node.exception}`;
  }
  const normalized = normalizeLicense(id);
  const corrected = spdxCorrect(normalized) ?? normalized;
  return targetLicenses.some((target) => {
    const correctedTarget = spdxCorrect(target);
    return isCompatibleWith(corrected, correctedTarget ?? target);
  });
}

/**
 * Check if a license expression is compatible with any of the target licenses.
 * Parses compound SPDX expressions (AND/OR/parentheses) into an AST via
 * spdx-expression-parse and evaluates them:
 *   OR  → any branch compatible = OK
 *   AND → all branches must be compatible
 */
export function isLicenseCompatible(
  license: string,
  targetLicenses: string[],
): boolean {
  const corrected = spdxCorrect(license) ?? license;

  try {
    const ast = spdxParse(corrected);
    return evaluateExpr(ast, targetLicenses);
  } catch {
    // Not a valid SPDX expression — try as a single normalized license
    const normalized = normalizeLicense(corrected);
    const norm2 = spdxCorrect(normalized) ?? normalized;
    return targetLicenses.some((target) => {
      const correctedTarget = spdxCorrect(target);
      return isCompatibleWith(norm2, correctedTarget ?? target);
    });
  }
}

/**
 * Classify a single SPDX license identifier as permissive, copyleft, or unknown.
 * Used by licenseLevelFromNode for AST-based compound expression evaluation.
 */
function classifySingleLicense(id: string): "permissive" | "copyleft" | "unknown" {
  if (PERMISSIVE.has(id)) return "permissive";
  const upper = id.toUpperCase();
  if (
    upper.startsWith("GPL-") || upper.startsWith("AGPL-") ||
    upper.startsWith("LGPL-") || upper.startsWith("MPL-") ||
    upper.startsWith("EPL-") || upper.startsWith("CDDL-") ||
    upper.startsWith("EUPL-") || upper.startsWith("OSL-") ||
    upper.startsWith("RPSL-") || upper.startsWith("SISSL")
  ) return "copyleft";
  // Apache-2.0 is permissive-leaning but treat as permissive for level purposes
  if (upper === "APACHE-2.0") return "permissive";
  if (upper === "BSL-1.0" || upper === "ARTISTIC-2.0" || upper === "ZPL-2.0" || upper === "ZPL-2.1") return "permissive";
  return "unknown";
}

/**
 * Walk an spdx-expression-parse AST node and return the most restrictive
 * license level for the expression:
 *   OR  → most permissive wins (any permissive branch → permissive)
 *   AND → most restrictive wins (any copyleft branch → copyleft)
 */
function licenseLevelFromNode(node: ReturnType<typeof spdxParse>): "permissive" | "copyleft" | "unknown" {
  if ("license" in node) {
    return classifySingleLicense(node.license);
  }
  const left = licenseLevelFromNode((node as { conjunction: string; left: ReturnType<typeof spdxParse>; right: ReturnType<typeof spdxParse> }).left);
  const right = licenseLevelFromNode((node as { conjunction: string; left: ReturnType<typeof spdxParse>; right: ReturnType<typeof spdxParse> }).right);
  if ((node as { conjunction: string }).conjunction === "or") {
    // OR: most permissive wins
    if (left === "permissive" || right === "permissive") return "permissive";
    if (left === "copyleft" || right === "copyleft") return "copyleft";
    return "unknown";
  }
  // AND: most restrictive wins
  if (left === "copyleft" || right === "copyleft") return "copyleft";
  if (left === "permissive" || right === "permissive") return "permissive";
  return "unknown";
}

/**
 * Return a coarse license level for a compound SPDX expression.
 * Parses the full AST (handles parentheses, AND, OR) via spdx-expression-parse.
 * Returns "permissive", "copyleft", or "unknown".
 *
 * Unlike `licenseLevelOrd` above, this handles parenthesized sub-expressions correctly
 * (it walks a real AST rather than splitting strings) — see `licenseLevelOrd`'s docstring
 * for why the two evaluators aren't unified.
 */
export function licenseLevel(expr: string): "permissive" | "copyleft" | "unknown" {
  try {
    const corrected = spdxCorrect(expr) ?? expr;
    const parsed = spdxParse(corrected);
    return licenseLevelFromNode(parsed);
  } catch {
    return "unknown";
  }
}

/**
 * Fetch the license for an npm package from the registry.
 */
/**
 * Check if a license string is a non-standard pointer/placeholder that should
 * be treated as "unknown" so fallback detection (e.g., GitHub API) can run.
 * Examples: "SEE LICENSE IN LICENSE", "SEE LICENSE IN https://..."
 */
function isNonStandardLicense(license: string): boolean {
  const upper = license.toUpperCase().trim();
  if (upper.startsWith("SEE LICENSE IN")) return true;
  return false;
}

export async function fetchNpmLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
  githubToken: string = "",
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  try {
    const result = await fetchWithRetry<{
      license?: string;
      repository?: { url?: string } | string;
    }>(`${registries.npm}/${name}/${version}`);
    if (result.kind === "not_found") return null;
    if (result.kind !== "ok") throw new LicenseFetchError(`npm registry ${result.kind} for ${name}@${version}`);
    const data = result.data;
    const rawLicense = data.license ?? null;
    if (rawLicense && !isNonStandardLicense(rawLicense)) return rawLicense;

    // Fall back to GitHub repo license API
    const repoUrl = typeof data.repository === "string"
      ? data.repository
      : data.repository?.url;
    if (repoUrl) {
      const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (ghMatch) {
        const ghName = `${ghMatch[1]}/${ghMatch[2]}`;
        const ghLicense = await fetchGitHubRepoLicense(ghName, githubToken, licenseHeuristics);
        if (ghLicense) return ghLicense;
      }
    }
    // Return original non-standard string as last resort (e.g., "SEE LICENSE IN ...")
    return rawLicense;
  } catch (err) {
    if (err instanceof LicenseFetchError) throw err;
    return null;
  }
}

/**
 * Extract LICENSE content from any .tar.gz tarball (streaming).
 * Looks for LICENSE* or COPYING* files at any depth.
 */
async function extractLicenseFromTarball(tarballUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(tarballUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok || !resp.body) return null;

    const extract = tar.extract();
    let licenseContent: string | null = null;

    const extractPromise = new Promise<void>((resolve, reject) => {
      extract.on("entry", (header, stream, next) => {
        const fileName = header.name.split("/").pop() ?? "";
        const upperName = fileName.toUpperCase();

        if (
          (upperName.startsWith("LICENSE") || upperName.startsWith("LICENCE") ||
           upperName.startsWith("COPYING")) &&
          header.type === "file" && !licenseContent
        ) {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            licenseContent = Buffer.concat(chunks).toString("utf8");
            next();
          });
        } else {
          stream.resume();
          stream.on("end", next);
        }
      });
      extract.on("finish", resolve);
      extract.on("error", reject);
    });

    const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);
    const gunzip = zlib.createGunzip();
    await Promise.all([
      pipeline(nodeStream, gunzip, extract),
      extractPromise,
    ]);

    if (licenseContent) {
      return detectLicenseFromText(licenseContent);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract LICENSE or README content from a PyPI sdist tarball (streaming).
 * Downloads the tarball and streams through it looking for LICENSE* or README* files
 * at the top level of the archive.
 */
async function extractLicenseFromSdist(sdistUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(sdistUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok || !resp.body) return null;

    const extract = tar.extract();
    const licenseFiles: Array<{ name: string; content: string }> = [];

    const extractPromise = new Promise<void>((resolve, reject) => {
      extract.on("entry", (header, stream, next) => {
        // Match top-level LICENSE* or README* files (e.g., "pkg-1.0/LICENSE")
        const parts = header.name.split("/");
        const fileName = parts.length >= 2 ? parts[1] : parts[0];
        const upperName = fileName.toUpperCase();

        if (
          (upperName.startsWith("LICENSE") || upperName.startsWith("LICENCE") ||
           upperName.startsWith("COPYING") || upperName.startsWith("README")) &&
          header.type === "file"
        ) {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            licenseFiles.push({
              name: fileName,
              content: Buffer.concat(chunks).toString("utf8"),
            });
            next();
          });
        } else {
          stream.resume();
          stream.on("end", next);
        }
      });
      extract.on("finish", resolve);
      extract.on("error", reject);
    });

    const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);
    const gunzip = zlib.createGunzip();
    // Pipeline: HTTP response → gunzip → tar extract
    await Promise.all([
      pipeline(nodeStream, gunzip, extract),
      extractPromise,
    ]);

    // Prefer LICENSE/LICENCE/COPYING files over README
    const licenseFile = licenseFiles.find((f) => {
      const u = f.name.toUpperCase();
      return u.startsWith("LICENSE") || u.startsWith("LICENCE") || u.startsWith("COPYING");
    });
    if (licenseFile) {
      const detected = detectLicenseFromText(licenseFile.content);
      if (detected) return detected;
    }

    // Fall back to README for license section
    const readmeFile = licenseFiles.find((f) => f.name.toUpperCase().startsWith("README"));
    if (readmeFile) {
      const detected = detectLicenseFromDescription(readmeFile.content);
      if (detected) return detected;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Python package from PyPI.
 */
export async function fetchPypiLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
  githubToken: string = "",
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  try {
    const result = await fetchWithRetry<{
      info?: {
        license?: string;
        license_expression?: string;
        classifiers?: string[];
      };
      urls?: Array<{ packagetype?: string; url?: string }>;
    }>(`${registries.pypi}/pypi/${name}/${version}/json`);
    if (result.kind === "not_found") return null;
    if (result.kind !== "ok") throw new LicenseFetchError(`PyPI registry ${result.kind} for ${name}@${version}`);
    const data = result.data;
    // PEP 639: try license_expression first (new standard field)
    if (data.info?.license_expression && data.info.license_expression !== "UNKNOWN") {
      return data.info.license_expression;
    }
    // Try license field
    if (data.info?.license && data.info.license !== "UNKNOWN") {
      return data.info.license;
    }
    // Try classifiers
    const licenseClassifier = data.info?.classifiers?.find((c) =>
      c.startsWith("License :: OSI Approved :: "),
    );
    if (licenseClassifier) {
      const parts = licenseClassifier.split(" :: ");
      return parts[parts.length - 1];
    }
    // Fall back to GitHub project URL
    const projectUrls = (data.info as Record<string, unknown>)?.project_urls as
      Record<string, string> | null | undefined;
    const homeUrl = projectUrls?.Homepage ?? projectUrls?.Source ??
      projectUrls?.Repository ?? projectUrls?.["Source Code"] ??
      projectUrls?.Code ?? projectUrls?.GitHub ??
      (data.info as Record<string, unknown>)?.home_page as string | undefined;
    if (homeUrl) {
      const ghMatch = homeUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      if (ghMatch) {
        const repo = ghMatch[1].replace(/\.git$/, "");
        const ghLicense = await fetchGitHubRepoLicense(repo, githubToken, licenseHeuristics);
        if (ghLicense) return ghLicense;
      }
    }
    if (licenseHeuristics) {
      // Fall back to description/README for license mentions
      const description = (data.info as Record<string, unknown>)?.description as string | undefined;
      if (description) {
        const descLicense = detectLicenseFromDescription(description);
        if (descLicense) return descLicense;
      }
      // Fall back to sdist tarball LICENSE/README
      const sdist = data.urls?.find((u) => u.packagetype === "sdist");
      if (sdist?.url) {
        const sdistLicense = await extractLicenseFromSdist(sdist.url);
        if (sdistLicense) return sdistLicense;
      }
    }
    return null;
  } catch (err) {
    if (err instanceof LicenseFetchError) throw err;
    return null;
  }
}

/**
 * Fetch the license for a Rust crate from crates.io.
 * Falls back to crate-level metadata if exact version lookup fails
 * (e.g. when version is a semver range like "1" or "0.26").
 */
export async function fetchCrateLicense(
  name: string,
  version: string,
  registries: RegistryUrls,
): Promise<string | null> {
  const headers = { "User-Agent": "lisan-al-gaib-action" };
  // Try exact version first
  try {
    const result = await fetchWithRetry<{ version?: { license?: string } }>(
      `${registries.crates}/api/v1/crates/${name}/${version}`,
      headers,
    );
    if (result.kind === "ok" && result.data.version?.license) {
      return result.data.version.license;
    }
    if (result.kind === "rate_limited" || result.kind === "error") {
      throw new LicenseFetchError(`crates.io ${result.kind} for ${name}@${version}`);
    }
    // not_found or ok-but-no-license: fall through to crate-level lookup
  } catch (err) {
    if (err instanceof LicenseFetchError) throw err;
    // fall through
  }
  // Fall back to crate-level metadata (latest version's license)
  try {
    const result = await fetchWithRetry<{ versions?: Array<{ license?: string }> }>(
      `${registries.crates}/api/v1/crates/${name}`,
      headers,
    );
    if (result.kind === "not_found") return null;
    if (result.kind !== "ok") throw new LicenseFetchError(`crates.io ${result.kind} for ${name}`);
    const versions = result.data.versions;
    if (versions?.length && versions[0].license) return versions[0].license;
    return null;
  } catch (err) {
    if (err instanceof LicenseFetchError) throw err;
    return null;
  }
}

// parseTagValue/parseAttributeValue disabled so numeric-looking license/version
// text is preserved verbatim as strings rather than coerced to numbers.
const xmlParser = new XMLParser({ parseTagValue: false, parseAttributeValue: false, processEntities: false });

interface PomXml {
  project?: {
    licenses?: {
      license?: { name?: string } | Array<{ name?: string }>;
    };
    parent?: {
      groupId?: string;
      artifactId?: string;
      version?: string;
    };
    scm?: {
      url?: string;
      connection?: string;
      developerConnection?: string;
    };
    url?: string;
  };
}

/**
 * Fetch POM XML from Maven repositories.
 * Uses AbortSignal.timeout to enforce the shared fetch timeout, matching the
 * behavior of the JSON-fetching helpers (fetchJson/fetchWithRetry).
 */
async function fetchPom(
  groupId: string,
  artifactId: string,
  version: string,
  repositories: string[],
): Promise<PomXml | null> {
  const groupPath = groupId.replace(/\./g, "/");
  for (const repo of repositories) {
    const base = repo.replace(/\/$/, "");
    const pomUrl = `${base}/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;
    try {
      const resp = await fetch(pomUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (resp.status === 404 || resp.status === 410) continue; // not in this repo, try next
      if (!resp.ok) throw new LicenseFetchError(`Maven HTTP ${resp.status} for ${pomUrl}`);
      const text = await resp.text();
      return xmlParser.parse(text) as PomXml;
    } catch (err) {
      if (err instanceof LicenseFetchError) throw err;
      continue;
    }
  }
  return null;
}

/**
 * Extract the first license name from a parsed POM.
 */
function extractPomLicense(pom: PomXml): string | null {
  const licenses = pom.project?.licenses?.license;
  if (!licenses) return null;
  if (Array.isArray(licenses)) {
    const names = licenses.map((l) => l?.name?.trim()).filter(Boolean) as string[];
    if (names.length === 0) return null;
    // Normalize each license name individually before joining
    const normalized = names.map((n) => normalizeLicense(n));
    if (normalized.length === 1) return normalized[0];
    // Multiple licenses in a POM means the consumer can choose (OR)
    return normalized.join(" OR ");
  }
  return licenses?.name?.trim() ?? null;
}

/**
 * Fetch the license for a Maven artifact by parsing the POM.
 * Follows parent POM chain (up to 5 levels) if the artifact POM has no license.
 */
export async function fetchMavenLicense(
  name: string,
  version: string,
  repositories: string[],
  registries: RegistryUrls,
  githubToken: string = "",
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  const parts = name.split(":");
  if (parts.length < 2) return null;

  const repos = [...repositories, registries.maven];
  let groupId = parts[0];
  let artifactId = parts[1];
  let ver = version;
  let scmUrl: string | undefined;
  let projectUrl: string | undefined;

  for (let depth = 0; depth < 5; depth++) {
    const pom = await fetchPom(groupId, artifactId, ver, repos);
    if (!pom) break;

    const license = extractPomLicense(pom);
    if (license) return license;

    // Capture SCM/URL for GitHub fallback
    if (!scmUrl) {
      scmUrl = pom.project?.scm?.url ?? pom.project?.scm?.connection
        ?? pom.project?.scm?.developerConnection;
    }
    if (!projectUrl) projectUrl = pom.project?.url;

    const parent = pom.project?.parent;
    if (!parent?.groupId || !parent?.artifactId || !parent?.version) break;

    groupId = parent.groupId;
    artifactId = parent.artifactId;
    ver = parent.version;
  }

  // Fall back to GitHub repo license API
  for (const url of [scmUrl, projectUrl]) {
    if (!url) continue;
    const ghMatch = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (ghMatch) {
      const repo = ghMatch[1].replace(/\.git$/, "");
      const ghLicense = await fetchGitHubRepoLicense(repo, githubToken, licenseHeuristics);
      if (ghLicense) return ghLicense;
    }
  }

  return null;
}

/**
 * Batch-fetch licenses for multiple GitHub repos via GraphQL.
 * Returns a map from "owner/repo" to SPDX ID (or null).
 */
export async function batchFetchGitHubLicenses(
  repos: string[],
  token: string,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (repos.length === 0 || !token) return result;

  // Build GraphQL query with aliases
  const chunks: string[][] = [];
  for (let i = 0; i < repos.length; i += 20) {
    chunks.push(repos.slice(i, i + 20));
  }

  for (const chunk of chunks) {
    const fields = chunk.map((repo, i) => {
      const [owner, name] = repo.split("/");
      if (!owner || !name) return "";
      return `repo${i}: repository(owner: "${owner}", name: "${name}") { licenseInfo { spdxId } }`;
    }).filter(Boolean);

    if (fields.length === 0) continue;

    const query = `query { ${fields.join("\n")} }`;
    try {
      const resp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "lisan-al-gaib-action",
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as { data?: Record<string, { licenseInfo?: { spdxId?: string } } | null> };
      if (!data.data) continue;

      chunk.forEach((repo, i) => {
        const entry = data.data?.[`repo${i}`];
        const spdxId = entry?.licenseInfo?.spdxId;
        result.set(repo, spdxId && spdxId !== "NOASSERTION" ? spdxId : null);
      });
    } catch {
      // Fall back to individual fetches
    }
  }

  return result;
}

/**
 * Fetch the license for a GitHub repository (used for actions ecosystem).
 */
export async function fetchGitHubRepoLicense(
  name: string,
  token: string,
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  const parts = name.split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lisan-al-gaib-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/license`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      license?: { spdx_id?: string };
      content?: string;
      encoding?: string;
    };
    const spdxId = data.license?.spdx_id;
    if (spdxId && spdxId !== "NOASSERTION") return spdxId;
    // If spdx_id is NOASSERTION, try to detect from LICENSE file content
    if (licenseHeuristics && data.content && data.encoding === "base64") {
      const text = Buffer.from(data.content, "base64").toString("utf8");
      const detected = detectLicenseFromText(text);
      if (detected) return detected;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the license for a Bazel module from BCR metadata.
 * Falls back to the module's GitHub homepage license if BCR metadata
 * has no licenses field.
 */
export async function fetchBcrLicense(
  name: string,
  version: string,
  bcrUrl: string,
  githubToken: string = "",
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  // BCR metadata is per-module (not per-version) on GitHub
  const bcrGitHub = "https://raw.githubusercontent.com/bazelbuild/bazel-central-registry/main";
  try {
    const url = `${bcrGitHub}/modules/${encodeURIComponent(name)}/metadata.json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (resp.status === 404 || resp.status === 410) return null; // module not in BCR
    if (!resp.ok) throw new LicenseFetchError(`BCR HTTP ${resp.status} for ${name}`);
    const data = (await resp.json()) as {
      licenses?: string[];
      homepage?: string;
      repository?: string[];
    };
    if (data.licenses?.length) return data.licenses[0];

    // Collect candidate URLs from homepage and repository fields
    const candidateUrls: string[] = [];
    if (data.homepage) candidateUrls.push(data.homepage);
    if (data.repository) candidateUrls.push(...data.repository);

    // Try GitHub URLs from candidates
    for (const url of candidateUrls) {
      const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
      if (ghMatch) {
        const license = await fetchGitHubRepoLicense(ghMatch[1].replace(/\.git$/, ""), githubToken, licenseHeuristics);
        if (license) return license;
      }
    }

    // Try source.json for this version — may have a GitHub URL
    try {
      const sourceUrl = `${bcrGitHub}/modules/${encodeURIComponent(name)}/${encodeURIComponent(version)}/source.json`;
      const sourceResp = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (sourceResp.ok) {
        const sourceData = (await sourceResp.json()) as { url?: string };
        if (sourceData.url) {
          const ghMatch = sourceData.url.match(/github\.com\/([^/]+\/[^/]+)/);
          if (ghMatch) {
            const license = await fetchGitHubRepoLicense(ghMatch[1].replace(/\.git$/, ""), githubToken, licenseHeuristics);
            if (license) return license;
          }
        }
      }
    } catch {
      // source.json fetch failed
    }

    return null;
  } catch (err) {
    if (err instanceof LicenseFetchError) throw err;
    return null;
  }
}

/**
 * Derive the license for a multitool binary from its download URL.
 * If the URL is on github.com, query the repo license.
 * Otherwise, follow redirects to see if they land on github.com.
 */
async function fetchMultitoolLicense(
  url: string,
  githubToken: string,
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  // Direct github.com URL
  const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\//);
  if (ghMatch) {
    return fetchGitHubRepoLicense(`${ghMatch[1]}/${ghMatch[2]}`, githubToken, licenseHeuristics);
  }

  // Follow redirects (HEAD request) to check if final URL is on github.com
  try {
    const resp = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const finalUrl = resp.url;
    const redirectMatch = finalUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\//);
    if (redirectMatch) {
      return fetchGitHubRepoLicense(`${redirectMatch[1]}/${redirectMatch[2]}`, githubToken, licenseHeuristics);
    }
  } catch {
    // Redirect check failed
  }

  // For .tar.gz URLs, try extracting LICENSE from the tarball
  if (licenseHeuristics && (url.endsWith(".tar.gz") || url.endsWith(".tgz"))) {
    const license = await extractLicenseFromTarball(url);
    if (license) return license;
  }

  return null;
}

/**
 * Fetch the license for a container image via OCI config-blob labels.
 * Reads org.opencontainers.image.licenses; falls back to org.opencontainers.image.source
 * pointing at a GitHub repo. Returns null if neither is present or accessible.
 */
export async function fetchImageLicense(
  ref: ParsedImageRef,
  githubToken: string = "",
  licenseHeuristics: boolean = true,
): Promise<string | null> {
  // Unlike the age-gate (which skips tag-only refs as mutable), licenses are
  // content-descriptive and rarely change, so we query by tag when digest is absent.
  const reference = ref.digest ?? ref.tag ?? "latest";
  const labels = await fetchImageLabels(ref.registry, ref.repository, reference);
  if (!labels) return null;

  const declared = labels["org.opencontainers.image.licenses"];
  if (declared?.trim()) return declared.trim();

  const source = labels["org.opencontainers.image.source"];
  if (source) {
    const ghMatch = source.match(/github\.com\/([^/]+\/[^/]+)/);
    if (ghMatch) {
      return fetchGitHubRepoLicense(
        ghMatch[1].replace(/\.git$/, ""),
        githubToken,
        licenseHeuristics,
      );
    }
  }
  return null;
}

/**
 * Fetch the license for a dependency based on its ecosystem.
 */
export async function fetchLicense(
  dep: { ecosystem: string; name: string; version: string },
  registries: RegistryUrls,
  javaRepoMap: Map<string, string[]>,
  githubToken: string,
  bcrUrl: string,
  licenseHeuristics: boolean = true,
  kubernetesImageRefs: Map<string, ParsedImageRef> = new Map(),
  dockerImageRefs: Map<string, ParsedImageRef> = new Map(),
): Promise<string | null> {
  switch (dep.ecosystem) {
    case "npm":
      return fetchNpmLicense(dep.name, dep.version, registries, githubToken, licenseHeuristics);
    case "python":
      return fetchPypiLicense(dep.name, dep.version, registries, githubToken, licenseHeuristics);
    case "rust":
      return fetchCrateLicense(dep.name, dep.version, registries);
    case "java":
      return fetchMavenLicense(
        dep.name,
        dep.version,
        javaRepoMap.get(dep.name) ?? [],
        registries,
        githubToken,
        licenseHeuristics,
      );
    case "actions":
      return fetchGitHubRepoLicense(dep.name, githubToken, licenseHeuristics);
    case "bazel":
      return fetchBcrLicense(dep.name, dep.version, bcrUrl, githubToken, licenseHeuristics);
    case "multitool":
      return fetchMultitoolLicense(dep.version, githubToken, licenseHeuristics);
    case "kubernetes": {
      const ref = kubernetesImageRefs.get(`${dep.name}@${dep.version}`);
      return ref ? fetchImageLicense(ref, githubToken, licenseHeuristics) : null;
    }
    case "docker": {
      const ref = dockerImageRefs.get(`${dep.name}@${dep.version}`);
      return ref ? fetchImageLicense(ref, githubToken, licenseHeuristics) : null;
    }
    default:
      return null;
  }
}

/**
 * Check licenses for all analyzed dependencies and return results.
 */
export async function checkLicenses(
  results: CheckResult[],
  targetLicenseMap: TargetLicenseMap,
  registries: RegistryUrls,
  javaRepoMap: Map<string, string[]>,
  githubToken: string,
  bcrUrl: string,
  overrides?: LicenseOverrides,
  licenseHeuristics: boolean = true,
  kubernetesImageRefs: Map<string, ParsedImageRef> = new Map(),
  dockerImageRefs: Map<string, ParsedImageRef> = new Map(),
): Promise<LicenseResult[]> {
  // Identify deps that need fetching (not overridden, not cached)
  const depsToCheck = results.filter(({ dep }) => {
    const ecoTargets = getEcosystemTargetLicenses(targetLicenseMap, dep.ecosystem);
    if (ecoTargets.length === 0) return false;
    const override = overrides?.get(dep.ecosystem)?.get(dep.name);
    if (override?.toLowerCase() === "ignore") return false;
    return true;
  });

  // Dedupe-and-batch-fetch via the same leaf helper the updater uses (src/update/resolve.ts)
  // so the "dedupe by cache key → runBatched → catch-per-task → null" pattern isn't
  // hand-rolled twice. Pass core.warning so a failed license fetch is visible as a GitHub
  // annotation rather than silently resolving to "no license declared".
  const toFetch = depsToCheck.filter(({ dep }) => !overrides?.get(dep.ecosystem)?.get(dep.name));
  const LICENSE_FETCH_CONCURRENCY = 10;
  const licenseCache = await dedupeAndResolve(
    toFetch,
    ({ dep }) => `${dep.ecosystem}:${dep.name}@${dep.version}`,
    ({ dep }) => fetchLicense(dep, registries, javaRepoMap, githubToken, bcrUrl, licenseHeuristics, kubernetesImageRefs, dockerImageRefs),
    LICENSE_FETCH_CONCURRENCY,
    core.warning,
  );

  // Process results
  const licenseResults: LicenseResult[] = [];
  for (const { dep } of depsToCheck) {
    const ecoTargets = getEcosystemTargetLicenses(targetLicenseMap, dep.ecosystem);
    const override = overrides?.get(dep.ecosystem)?.get(dep.name);
    const cacheKey = `${dep.ecosystem}:${dep.name}@${dep.version}`;
    const rawLicense = override ?? licenseCache.get(cacheKey) ?? null;

    const normalized = rawLicense ? normalizeLicense(rawLicense) : null;
    const spdx = normalized ? (spdxCorrect(normalized) ?? normalized) : null;
    let compatible: boolean | null = null;

    if (spdx) {
      compatible = isLicenseCompatible(spdx, ecoTargets);
    }

    licenseResults.push({
      name: dep.name,
      version: dep.version,
      ecosystem: dep.ecosystem,
      license: rawLicense,
      spdx,
      compatible,
    });
  }

  return licenseResults;
}

/**
 * Get the workflow file path from GITHUB_WORKFLOW_REF.
 * Format: {owner}/{repo}/{path}@{ref}
 */
export function getWorkflowFile(): string | null {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  if (!workflowRef) return null;
  try {
    const { owner, repo } = github.context.repo;
    const prefix = `${owner}/${repo}/`;
    if (!workflowRef.startsWith(prefix)) return null;
    const rest = workflowRef.slice(prefix.length);
    const atIdx = rest.lastIndexOf("@");
    return atIdx === -1 ? null : rest.slice(0, atIdx);
  } catch {
    return null;
  }
}

/**
 * Build override YAML block for license-overrides input.
 */
function buildOverridesYaml(
  violations: LicenseResult[],
  unknowns: LicenseResult[],
): Map<string, Map<string, string>> {
  const overrides = new Map<string, Map<string, string>>();
  for (const lr of [...violations, ...unknowns]) {
    if (!overrides.has(lr.ecosystem)) overrides.set(lr.ecosystem, new Map());
    overrides.get(lr.ecosystem)!.set(lr.name, "ignore");
  }
  return overrides;
}

/**
 * Find the insertion point in the workflow file for an input block under the action's `with:`.
 * Returns the line index to insert at, or -1 if not found.
 */
export function findWorkflowInsertIdx(allLines: string[]): number {
  const actionPattern = /uses:.*lisan-al-gaib/;
  const actionLineIdx = allLines.findIndex((l) => actionPattern.test(l));
  if (actionLineIdx === -1) return -1;

  let insertIdx = allLines.length;
  let inWith = false;
  for (let i = actionLineIdx + 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (/^\s*with:/.test(line)) {
      inWith = true;
      continue;
    }
    if (inWith && line.trim() !== "") {
      const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (lineIndent < 10) {
        insertIdx = i;
        break;
      }
    }
  }
  return insertIdx;
}

/**
 * Build a YAML block string for license-overrides.
 */
function buildOverrideBlock(overrides: Map<string, Map<string, string>>): string {
  const indent = "            "; // 12 spaces
  const lines: string[] = [`${indent.slice(2)}license-overrides: |`];
  for (const [eco, pkgs] of overrides) {
    lines.push(`${indent}${eco}:`);
    for (const [name, license] of pkgs) {
      lines.push(`${indent}  ${yamlQuote(name)}: ${yamlQuote(license)}`);
    }
  }
  return lines.join("\n");
}

async function showOverrideDiff(
  violations: LicenseResult[],
  unknowns: LicenseResult[],
  licenseHeuristics: boolean = true,
  inferredLicenses?: Map<string, string>,
): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) return;
  if (violations.length === 0 && unknowns.length === 0) return;

  const workflowFile = getWorkflowFile();
  if (!workflowFile) return;

  let original: string;
  try {
    original = await fs.readFile(workflowFile, "utf8");
  } catch {
    return;
  }

  const overrides = buildOverridesYaml(violations, unknowns);
  if (overrides.size === 0) return;

  const allLines = original.split("\n");
  const indent = "            "; // 12 spaces

  const showLicenseDiff = async (
    theOverrides: Map<string, Map<string, string>>,
    groupName: string,
  ): Promise<void> => {
    if (original.includes("license-overrides:")) {
      // Append new entries to existing license-overrides block
      const loIdx = allLines.findIndex((l) => /^\s*license-overrides:/.test(l));
      if (loIdx === -1) return;

      const loIndent = allLines[loIdx].match(/^(\s*)/)?.[1]?.length ?? 0;
      let endIdx = loIdx + 1;
      while (endIdx < allLines.length) {
        const line = allLines[endIdx];
        if (line.trim() === "") { endIdx++; continue; }
        const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (lineIndent <= loIndent) break;
        endIdx++;
      }

      const existingContent = allLines.slice(loIdx + 1, endIdx).join("\n");
      const newLines: string[] = [];
      for (const [eco, pkgs] of theOverrides) {
        const newPkgs = [...pkgs].filter(([name]) => !existingContent.includes(name));
        if (newPkgs.length === 0) continue;
        if (!existingContent.includes(`${eco}:`)) {
          newLines.push(`${indent}${eco}:`);
        }
        for (const [name, license] of newPkgs) {
          newLines.push(`${indent}  ${yamlQuote(name)}: ${yamlQuote(license)}`);
        }
      }
      if (newLines.length === 0) return;

      const modified = [...allLines];
      modified.splice(endIdx, 0, ...newLines);
      await showGroupedDiff(workflowFile, original, modified.join("\n"), groupName);
    } else {
      const insertIdx = findWorkflowInsertIdx(allLines);
      if (insertIdx === -1) return;

      const block = buildOverrideBlock(theOverrides);
      const modified = [...allLines];
      modified.splice(insertIdx, 0, block);
      await showGroupedDiff(workflowFile, original, modified.join("\n"), groupName);
    }
  };

  await showLicenseDiff(
    overrides,
    'Suggested: add license-overrides to your workflow (use "ignore" if you don\'t care)',
  );

  // When heuristics is off, show a second diff with inferred licenses
  if (!licenseHeuristics && inferredLicenses && inferredLicenses.size > 0) {
    const inferredOverrides = new Map<string, Map<string, string>>();
    for (const [eco, pkgs] of overrides) {
      for (const [name] of pkgs) {
        const key = `${eco}:${name}`;
        const inferred = inferredLicenses.get(key);
        if (inferred) {
          if (!inferredOverrides.has(eco)) inferredOverrides.set(eco, new Map());
          inferredOverrides.get(eco)!.set(name, inferred);
        }
      }
    }

    if (inferredOverrides.size > 0) {
      await showLicenseDiff(
        inferredOverrides,
        "Suggested: use heuristically inferred licenses (if you trust the inference)",
      );
    }
  }
}

/**
 * Emit annotations for license violations.
 */
export async function emitLicenseAnnotations(
  licenseResults: LicenseResult[],
  checkResults: CheckResult[],
  licenseHeuristics: boolean = true,
  inferredLicenses?: Map<string, string>,
): Promise<number> {
  let violations = 0;
  const violationResults: LicenseResult[] = [];
  const unknownResults: LicenseResult[] = [];

  for (const lr of licenseResults) {
    if (lr.compatible === false) {
      const cr = checkResults.find(
        (r) => r.dep.name === lr.name && r.dep.version === lr.version,
      );
      core.error(
        `[${lr.ecosystem}] ${lr.name}@${lr.version} has incompatible license: ${lr.spdx ?? lr.license}`,
        cr ? { file: cr.dep.file } : undefined,
      );
      violations++;
      violationResults.push(lr);
    } else if (lr.compatible === null && lr.license === null) {
      const cr = checkResults.find(
        (r) => r.dep.name === lr.name && r.dep.version === lr.version,
      );
      core.warning(
        `[${lr.ecosystem}] ${lr.name}@${lr.version}: could not determine license`,
        cr ? { file: cr.dep.file } : undefined,
      );
      unknownResults.push(lr);
    }
  }

  await showOverrideDiff(violationResults, unknownResults, licenseHeuristics, inferredLicenses);

  return violations;
}
