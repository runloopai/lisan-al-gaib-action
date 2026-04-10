import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import type { ChangedDep } from "./types.js";

interface ActionRef {
  owner: string;
  repo: string;
  path: string; // empty if no subpath
  ref: string;
  raw: string; // full uses string
}

const SHA_RE = /^[0-9a-f]{40}$/;

function isCommitSha(ref: string): boolean {
  return SHA_RE.test(ref);
}

/**
 * Parse `uses:` directives from a workflow or composite action YAML file.
 * Returns a map of "owner/repo@ref" (or "owner/repo/path@ref") → ActionRef.
 */
export function parseActionRefs(content: string): Map<string, ActionRef> {
  const refs = new Map<string, ActionRef>();
  // Match: uses: owner/repo@ref or uses: owner/repo/path@ref
  // Skip: uses: ./local, uses: docker://..., uses: ./.github/...
  const re = /\buses:\s*['"]?([^'"#\s]+)['"]?/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const raw = match[1];
    // Skip local and docker actions
    if (raw.startsWith("./") || raw.startsWith("docker://")) continue;

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

    refs.set(raw, { owner, repo, path: subpath, ref, raw });
  }
  return refs;
}

const DEFAULT_WORKFLOW_GLOBS = [
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

    for (const [key, ref] of headRefs) {
      // Skip if unchanged from base
      if (baseRefs.has(key)) continue;

      // Skip branch-based refs (not a SHA and not likely a tag)
      // We'll determine this more precisely during publish date lookup
      // For now, include all non-branch refs; the registry query will skip branches

      allDeps.push({
        ecosystem: "actions",
        name: `${ref.owner}/${ref.repo}${ref.path ? "/" + ref.path : ""}`,
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

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dependency-age-check-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (isCommitSha(ref)) {
    return getCommitDate(owner, repo, ref, headers);
  }

  // Try as a tag first
  const tagDate = await getTagDate(owner, repo, ref, headers);
  if (tagDate !== null) return tagDate;

  // Not a tag → assume branch → skip
  core.info(`actions: ${name}@${ref} appears to be a branch, skipping`);
  return null;
}

async function getCommitDate(
  owner: string,
  repo: string,
  sha: string,
  headers: Record<string, string>,
): Promise<Date | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
      { headers },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      commit?: { committer?: { date?: string } };
    };
    const date = data?.commit?.committer?.date;
    return date ? new Date(date) : null;
  } catch {
    return null;
  }
}

async function getTagDate(
  owner: string,
  repo: string,
  tag: string,
  headers: Record<string, string>,
): Promise<Date | null> {
  try {
    // First check if this ref is a tag
    const refResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${tag}`,
      { headers },
    );
    if (!refResp.ok) return null;

    const refData = (await refResp.json()) as {
      object?: { type?: string; sha?: string; url?: string };
    };
    if (!refData.object) return null;

    // If it's an annotated tag, fetch the tag object for the tagger date
    if (refData.object.type === "tag" && refData.object.url) {
      const tagResp = await fetch(refData.object.url, { headers });
      if (tagResp.ok) {
        const tagData = (await tagResp.json()) as {
          tagger?: { date?: string };
        };
        if (tagData?.tagger?.date) {
          return new Date(tagData.tagger.date);
        }
      }
    }

    // Lightweight tag or fallback — get the commit date
    if (refData.object.sha) {
      return getCommitDate(owner, repo, refData.object.sha, headers);
    }

    return null;
  } catch {
    return null;
  }
}
