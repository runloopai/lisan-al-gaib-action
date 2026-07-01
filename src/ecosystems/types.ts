export interface ChangedDep {
  ecosystem: string;
  name: string;
  version: string;
  file: string;
}

export type DepStatus = "pass" | "warn" | "fail" | "unknown";

export interface CheckResult {
  dep: ChangedDep;
  publishDate: Date | null;
  ageDays: number | null;
  status: DepStatus;
}

/**
 * Resolved version reference from a Starlark expression — either a direct string
 * literal or a constant variable (possibly interpolated via %).
 *
 * `nodeStart`/`nodeEnd` are tree-sitter UTF-16 code-unit offsets INSIDE the quotes
 * of the literal that must be rewritten (the constant's value literal, not the call site).
 * These match JavaScript's String.prototype.slice — do NOT convert to byte offsets.
 * `templatePrefix`/`templateSuffix` are the fragments added around the constant
 * value by the interpolation template (empty strings for bare-constant and
 * direct-literal references). The new constant value to write is:
 *   `newVersion.slice(templatePrefix.length, newVersion.length - templateSuffix.length)`
 * i.e., strip the prefix/suffix from candidate.latest to recover the constant-only fragment.
 */
export interface VersionRef {
  value: string;
  nodeStart: number;
  nodeEnd: number;
  templatePrefix: string;
  templateSuffix: string;
  constantName?: string;
  /** The quote character used in the source literal: `"` or `'`. Defaults to `"`. */
  quote?: string;
  /**
   * Set when the version was derived from a lossy, non-invertible Starlark
   * expression (e.g. `CONST.rpartition(".")[0]` drops the last version segment).
   * Such refs are resolved for age-gating but must never be rewritten — the
   * constant is driven by a non-lossy sibling reference (e.g. a bare `CONST`
   * or `%`-interpolation that references the full version).
   */
  readOnly?: boolean;
}

export interface CrateSpec {
  package: string;
  version: string;
  isGit: boolean;
  // Tree-sitter UTF-16 code-unit offsets for the version string literal (quotes excluded)
  versionNodeStart?: number;
  versionNodeEnd?: number;
  // Richer version reference — set for all resolved versions (direct literals AND constants)
  versionRef?: VersionRef;
}

/**
 * A single Maven artifact entry from a maven.install() artifacts= list.
 * `coord` is the fully-resolved "group:artifact:version" coordinate string.
 * `versionRef` is set when the version (or the whole coord) came from a constant
 * variable or % interpolation — the updater uses it for offset-based rewrites.
 */
export interface MavenArtifact {
  coord: string;
  versionRef?: VersionRef;
}

/**
 * A single maven.artifact() call — a standalone artifact specification that is
 * NOT embedded in a maven.install() artifacts= list.
 */
export interface MavenArtifactRef {
  group: string;
  artifact: string;
  version: string;
  versionRef?: VersionRef;
}

export interface MavenInstall {
  name: string | null;
  lockFile: string;
  repositories: string[];
  artifacts: MavenArtifact[];
}

export interface BazelOverride {
  type: "git" | "archive" | "local_path" | "single_version" | "multiple_version";
  moduleName: string;
  // git_override
  remote?: string;
  commit?: string;
  tag?: string;
  branch?: string;
  // archive_override
  urls?: string[];
  // single_version_override / multiple_version_override
  version?: string;
  versions?: string[];
  registry?: string;
  // Tree-sitter UTF-16 code-unit offsets for the version string literal in single_version_override (quotes excluded)
  versionNodeStart?: number;
  versionNodeEnd?: number;
  versionRef?: VersionRef;
}

export interface BazelDep {
  name: string;
  version: string;
  // Tree-sitter UTF-16 code-unit offsets for the version string literal (quotes excluded)
  versionNodeStart?: number;
  versionNodeEnd?: number;
  versionRef?: VersionRef;
}

export interface MultitoolBinary {
  kind: string;
  url: string;
  sha256: string;
  os: string;
  cpu: string;
  file?: string;
}

export interface MultitoolEntry {
  binaries: MultitoolBinary[];
}

export interface ParsedImageRef {
  raw: string;
  registry: string;
  repository: string;
  tag: string | null;
  digest: string | null;
}
