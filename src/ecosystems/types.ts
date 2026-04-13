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

export interface CrateSpec {
  package: string;
  version: string;
  isGit: boolean;
}

export interface MavenInstall {
  name: string | null;
  lockFile: string;
  repositories: string[];
  artifacts: string[];
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
