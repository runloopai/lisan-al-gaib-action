import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import { githubApiFetch } from "../registry.js";
import type { ChangedDep } from "./types.js";

interface ActionRef {
  owner: string;
  repo: string;
  path: string; // empty if no subpath
  ref: string;
  raw: string; // full uses string
}

/**
 * ActionRef extended with source-level position info.
 * The `raw` field (inherited from ActionRef) is the full `uses:` value string,
 * e.g. "actions/checkout@v3".
 * All offsets/lengths are UTF-16 code-unit positions (matching String.prototype.slice).
 */
export interface ActionRefWithPos extends ActionRef {
  /** UTF-16 code-unit offset of the full `uses: <value>` match start in the source string */
  matchOffset: number;
  /** UTF-16 code-unit length of the full `uses: <value>` match (including "uses: " prefix) */
  matchLength: number;
  /** Trailing inline comment if present, e.g. "# v3.0.0" — null otherwise */
  trailingComment: string | null;
  /** Length (including leading whitespace) of the trailing comment segment; 0 if absent */
  trailingCommentLength: number;
  /** The quote character wrapping the value ('"' or "'") — null if unquoted */
  quoteChar: string | null;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const branchSkipLogged = new Set<string>();
// Cache ref → resolved commit SHA (null = resolution failed / branch). Shared across files in a run.
const refShaCache = new Map<string, string | null>();

// Exported for test isolation only — clears module-level caches between test cases.
export function __resetCaches(): void {
  refShaCache.clear();
  branchSkipLogged.clear();
}

export function isCommitSha(ref: string): boolean {
  return SHA_RE.test(ref);
}

/**
 * Resolve a ref (SHA, tag, or branch) to its underlying commit SHA via the GitHub API.
 * Returns the SHA, or null if resolution fails (rate-limited, private repo, branch, error).
 * Caches results to avoid redundant API calls within a run.
 */
export async function resolveRefToSha(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const cacheKey = `${owner}/${repo}@${ref}`;
  const cached = refShaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (isCommitSha(ref)) {
    refShaCache.set(cacheKey, ref);
    return ref;
  }

  const result = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
    token,
  );
  const sha =
    result.kind === "ok" && typeof (result.data as { sha?: string })?.sha === "string"
      ? (result.data as { sha: string }).sha
      : null;
  refShaCache.set(cacheKey, sha);
  return sha;
}

/**
 * Parse `uses:` directives from a workflow or composite action YAML file.
 * Returns a map of "owner/repo@ref" (or "owner/repo/path@ref") → ActionRef.
 * Delegates to parseActionRefsWithPositions (single parse grammar for both consumers).
 */
export function parseActionRefs(content: string): Map<string, ActionRef> {
  const refs = new Map<string, ActionRef>();
  for (const r of parseActionRefsWithPositions(content)) {
    refs.set(r.raw, { owner: r.owner, repo: r.repo, path: r.path, ref: r.ref, raw: r.raw });
  }
  return refs;
}

/**
 * Parse `uses:` directives from a workflow or composite action YAML file,
 * returning position info (byte offset and length of each match in the
 * original source string, plus any trailing inline comment).
 *
 * The returned map is keyed by the raw `uses:` value (same as parseActionRefs).
 */
export function parseActionRefsWithPositions(
  content: string,
): ActionRefWithPos[] {
  const refs: ActionRefWithPos[] = [];
  // Filter out YAML comment lines before regex matching (same as parseActionRefs),
  // but we operate on the original content for offset tracking.
  // Build a per-line comment-mask: lines that are comment-only are skipped.
  const lines = content.split("\n");

  // We scan the original content directly, skipping comment lines by tracking
  // which character ranges belong to comment-only lines.
  const commentLineRanges = new Set<number>(); // line indices that are comment-only
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("#")) {
      commentLineRanges.add(i);
    }
  }

  // Pre-scan for `run:` block-scalar spans (YAML `|`/`>` block scalars after a `run:` key).
  // Lines inside such spans contain arbitrary shell code which may include a literal "uses:"
  // token that would pass the linePrefix whitespace guard — they must be excluded entirely.
  // Algorithm: when a `run: |` or `run: >` is found at indentation N, mark all subsequent
  // lines whose indentation is STRICTLY greater than N as block-scalar body lines.
  // Blank lines inside a block scalar are left-unmarked (they can never match the `uses:` regex
  // since the regex requires a non-whitespace value), so skipping them is harmless.
  const runBlockScalarLines = new Set<number>();
  // Matches `run: |` or `run: >` in both mapping (`run: |`) and sequence (`- run: |`) forms.
  // Group 1 captures everything before `run` (leading spaces + optional `- `) so blockIndent
  // equals the column position of the `run` keyword — block scalar body must be indented
  // strictly beyond that column.
  const runBlockRe = /^([ \t]*(?:-[ \t]+)?)run\s*:[ \t]*[|>]/;
  for (let i = 0; i < lines.length; i++) {
    const m = runBlockRe.exec(lines[i]);
    if (!m) continue;
    const blockIndent = m[1].length; // column of the `run` keyword
    for (let j = i + 1; j < lines.length; j++) {
      const jLine = lines[j];
      const jTrimmed = jLine.trimStart();
      if (jTrimmed === "") continue; // blank lines: remain inside the block scalar, skip marking
      const jIndent = jLine.length - jTrimmed.length;
      if (jIndent > blockIndent) {
        runBlockScalarLines.add(j);
      } else {
        break; // dedent to ≤ blockIndent ends the block scalar
      }
    }
  }

  // Build line start offsets so we can map a match offset to a line index.
  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1; // +1 for '\n'
  }

  // Capture optional opening quote char (group 1), then the value (group 2).
  const re = /\buses:\s*(['"]?)([^'"#\s]+)\1/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    // Binary search lineStarts to find which line this match falls on
    const offset = match.index;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineIdx = lo;

    // Skip if this line is a comment-only line
    if (commentLineRanges.has(lineIdx)) continue;

    // Skip lines that are inside a `run:` block scalar body — they contain arbitrary shell
    // code whose `uses:` tokens are not YAML step directives. Without this guard, a shell
    // script line like `    uses: fake/action@v1` would pass the linePrefix whitespace check
    // and be mistakenly treated as a real action ref, causing a corrupting byte-offset rewrite.
    if (runBlockScalarLines.has(lineIdx)) continue;

    // Skip if `uses:` is not the first key-value token on the line (e.g. inside a run: shell string).
    // The text from line start up to the `uses:` keyword must be only whitespace and list-bullet dashes.
    const linePrefix = content.slice(lineStarts[lineIdx], match.index);
    if (!/^[\s-]*$/.test(linePrefix)) continue;

    const quoteChar = match[1] || null;
    const raw = match[2];
    // Skip local, docker, and any runtime-variable action refs.
    // Any "$" in the ref (bash variable like "$ACTIONS_REF" or GHA expression
    // like "${{ matrix.ref }}") means the value is not a literal and cannot be
    // safely rewritten — the resolved value is unknown at parse time.
    if (raw.startsWith("./") || raw.startsWith("docker://") || raw.includes("$")) continue;

    const atIdx = raw.lastIndexOf("@");
    if (atIdx === -1) continue;

    const fullName = raw.slice(0, atIdx);
    const ref = raw.slice(atIdx + 1);

    // Parse owner/repo or owner/repo/path
    const parts = fullName.split("/");
    if (parts.length < 2) continue;

    const owner = parts[0];
    const repo = parts[1];
    const subpath = parts.slice(2).join("/");

    // Scan for trailing inline comment on the same line, after the match ends.
    // Capture leading whitespace too so trailingCommentLength includes it.
    const matchEnd = match.index + match[0].length;
    const lineEnd = lineStarts[lineIdx] + lines[lineIdx].length;
    const afterMatch = content.slice(matchEnd, lineEnd);
    const commentMatch = /^(\s*#[^\r\n]*)/.exec(afterMatch);
    const trailingCommentLength = commentMatch ? commentMatch[1].length : 0;
    const trailingComment = trailingCommentLength > 0 ? commentMatch![1].trimStart() : null;

    const refWithPos: ActionRefWithPos = {
      owner,
      repo,
      path: subpath,
      ref,
      raw,
      matchOffset: match.index,
      matchLength: match[0].length,
      trailingComment,
      trailingCommentLength,
      quoteChar,
    };

    refs.push(refWithPos);
  }

  return refs;
}

/** Exported so the updater can reuse the same default glob list without duplicating it. */
export const DEFAULT_WORKFLOW_GLOBS = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".github/actions/*/action.yml",
  ".github/actions/*/action.yaml",
  "action.yml",
  "action.yaml",
];

export async function getChangedDeps(
  baseRef: string,
  workflowFilesInput: string,
  token = "",
): Promise<ChangedDep[]> {
  let files: string[];

  if (workflowFilesInput) {
    const allFiles = new Set(await resolveFiles(workflowFilesInput));
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter((f) => allFiles.has(f));
  } else {
    // Auto-detect: find which default workflow files were changed
    const changedFiles = new Set(await gitDiffNameOnly(baseRef));
    files = [];
    for (const pattern of DEFAULT_WORKFLOW_GLOBS) {
      try {
        const resolved = await resolveFiles(pattern);
        for (const f of resolved) {
          if (changedFiles.has(f)) files.push(f);
        }
      } catch {
        // pattern didn't match anything
      }
    }
  }

  if (files.length === 0) {
    core.info("actions: no changed workflow files");
    return [];
  }

  const allDeps: ChangedDep[] = [];

  for (const file of files) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) continue;

    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`actions: could not read ${file}`);
      continue;
    }

    const baseContent = await gitShowFile(baseRef, file);
    const headRefs = parseActionRefs(headContent);
    const baseRefs = baseContent ? parseActionRefs(baseContent) : new Map<string, ActionRef>();

    // Group base refs by action name so we can compare commit SHAs when the ref string changes.
    const baseByName = new Map<string, ActionRef[]>();
    for (const bRef of baseRefs.values()) {
      const n = `${bRef.owner}/${bRef.repo}${bRef.path ? "/" + bRef.path : ""}`;
      const arr = baseByName.get(n) ?? [];
      arr.push(bRef);
      baseByName.set(n, arr);
    }

    for (const [key, ref] of headRefs) {
      // Skip if the exact ref string is unchanged from base
      if (baseRefs.has(key)) continue;

      const name = `${ref.owner}/${ref.repo}${ref.path ? "/" + ref.path : ""}`;
      const sameNameBase = baseByName.get(name);

      if (sameNameBase) {
        // Base had this action with a different ref string — resolve both sides to commit SHAs.
        // If the underlying commit is unchanged, the PR didn't actually change the action's code,
        // so skip it. If resolution fails for either side, flag conservatively (never skip on doubt).
        const headSha = await resolveRefToSha(ref.owner, ref.repo, ref.ref, token);
        if (headSha !== null) {
          let sameCommit = false;
          for (const bRef of sameNameBase) {
            const baseSha = await resolveRefToSha(bRef.owner, bRef.repo, bRef.ref, token);
            if (baseSha === headSha) {
              sameCommit = true;
              break;
            }
          }
          if (sameCommit) continue;
        }
      }

      allDeps.push({
        ecosystem: "actions",
        name,
        version: ref.ref,
        file,
      });
    }
  }

  return allDeps;
}

/**
 * Query GitHub API to get the date associated with an action ref.
 * - Commit SHA: get commit date
 * - Tag: get tag/release date
 * - Branch: return null (skip)
 */
export async function getPublishDate(
  name: string,
  ref: string,
  token: string,
): Promise<Date | null> {
  // Extract owner/repo from name (strip subpath if present)
  const parts = name.split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];

  if (isCommitSha(ref)) {
    return getCommitDate(owner, repo, ref, token);
  }

  // Try as a tag first
  const tagDate = await getTagDate(owner, repo, ref, token);
  if (tagDate !== null) return tagDate;

  // Not a tag → assume branch → skip (dedup log)
  const key = `${name}@${ref}`;
  if (!branchSkipLogged.has(key)) {
    branchSkipLogged.add(key);
    core.info(`actions: ${key} appears to be a branch, skipping`);
  }
  return null;
}

async function getCommitDate(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<Date | null> {
  const result = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
    token,
  );
  if (result.kind !== "ok") return null;
  const data = result.data as { commit?: { committer?: { date?: string } } };
  const date = data?.commit?.committer?.date;
  return date ? new Date(date) : null;
}

async function getTagDate(
  owner: string,
  repo: string,
  tag: string,
  token: string,
): Promise<Date | null> {
  // First check if this ref is a tag
  const refResult = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${tag}`,
    token,
  );
  if (refResult.kind !== "ok") return null;

  const refData = refResult.data as {
    object?: { type?: string; sha?: string; url?: string };
  };
  if (!refData.object) return null;

  // If it's an annotated tag, fetch the tag object for the tagger date
  if (refData.object.type === "tag" && refData.object.url) {
    const tagResult = await githubApiFetch(refData.object.url, token);
    if (tagResult.kind === "ok") {
      const tagData = tagResult.data as { tagger?: { date?: string } };
      if (tagData?.tagger?.date) {
        return new Date(tagData.tagger.date);
      }
    }
  }

  // Lightweight tag or fallback — get the commit date
  if (refData.object.sha) {
    return getCommitDate(owner, repo, refData.object.sha, token);
  }

  return null;
}
