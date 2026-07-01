// How restrictive the update mode is
export type UpdateMode = "major" | "minor" | "patch";

// How to write the updated ref in the file
export type UpdateStyle = "sha" | "preserve";

// Whether to allow downgrading to older versions
export type AllowDowngrade = "no" | "allow" | "only";

// How to handle a suggested update whose license is more restrictive than current
export type LicensePolicy = "block" | "warn" | "off";

// A discovered dependency reference from a source file
export interface DepRef {
  ecosystem: "npm" | "python" | "rust" | "java" | "bazel" | "actions" | "docker" | "kubernetes" | "multitool";
  name: string;      // e.g. "actions/checkout", "serde", "com.google.guava:guava", "nginx"
  file: string;      // absolute or repo-relative file path
  current: string;   // current version/ref string as it appears in the file
  // Opaque position data — the ecosystem module that created this owns its interpretation
  position: unknown;
  // Ecosystem-specific extra fields
  repositories?: string[];  // java: maven.install(repositories=...) for this artifact
}

// A version candidate returned by a registry
export interface VersionInfo {
  version: string;
  publishDate: Date | null;
  ageDays: number | null;  // computed from publishDate; null if publishDate is null
}

// A resolved update candidate ready to present to the user
export interface UpdateCandidate {
  dep: DepRef;
  latest: string;          // target version tag/string
  pinnedTo?: string;       // for actions/containers: the resolved SHA or digest to write
  updateLevel: "major" | "minor" | "patch";
  publishDate: Date | null;
  ageDays: number | null;
  breaking: boolean;       // true if updateLevel === "major"
  direction: "upgrade" | "downgrade";
  // License permissiveness check (populated by Step 8 in run.ts)
  licenseCurrent?: string | null;
  licenseNew?: string | null;
  licenseRegresses?: boolean;
  licenseBlocked?: boolean;   // true when licenseRegresses && policy=block
}

// A single rewrite operation within a file.
// Offset-based: applied in reverse order (highest offset first) to preserve positions.
//   Offsets are UTF-16 code-unit positions (matching String.prototype.slice), NOT byte offsets —
//   do NOT convert to Buffer byte indices or non-ASCII rewrites will be mis-targeted.
export interface OffsetRewrite { offset: number; length: number; replace: string; expected: string }
// String-based: applied via replaceAll across the entire file content.
export interface StringRewrite { search: string; replace: string }

export type Rewrite = OffsetRewrite | StringRewrite;

// A set of rewrites to apply to a file
export interface FileEdit {
  file: string;
  rewrites: Rewrite[];
}
