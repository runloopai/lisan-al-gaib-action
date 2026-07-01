import * as github from "@actions/github";
import * as core from "@actions/core";
import * as exec from "@actions/exec";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Get the parent commit SHA of the current HEAD.
 * Used as a fallback when payload.before is unavailable or invalid.
 */
async function getParentSha(): Promise<string | null> {
  let output = "";
  const exitCode = await exec.exec("git", ["rev-parse", "HEAD~1"], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return exitCode === 0 ? output.trim() : null;
}

/**
 * Check if a ref exists in the local git repo.
 */
async function refExists(ref: string): Promise<boolean> {
  const exitCode = await exec.exec("git", ["rev-parse", "--verify", ref], {
    silent: true,
    ignoreReturnCode: true,
  });
  return exitCode === 0;
}

function isZeroSha(sha: string): boolean {
  // Match the SHA-1 all-zeros sentinel (40 zeros) and the SHA-256 all-zeros sentinel (64 zeros).
  return /^0{40}$/.test(sha) || /^0{64}$/.test(sha);
}

export function resolveBaseRef(inputBaseRef: string): string {
  if (inputBaseRef) {
    core.info(`Using provided base-ref: ${inputBaseRef}`);
    return inputBaseRef;
  }

  const { eventName, payload } = github.context;

  // pull_request / pull_request_target
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const sha = payload.pull_request?.base?.sha;
    if (sha) {
      core.info(`Auto-detected base ref from PR base: ${sha}`);
      return sha;
    }
  }

  // merge_group
  if (eventName === "merge_group") {
    const sha = payload.merge_group?.base_sha;
    if (sha) {
      core.info(`Auto-detected base ref from merge group: ${sha}`);
      return sha;
    }
  }

  // push — use the "before" commit
  if (eventName === "push") {
    const before = payload.before;
    if (before && !isZeroSha(before)) {
      core.info(`Auto-detected base ref from push before: ${before}`);
      return before;
    }
  }

  // release — use the target commitish (branch/tag the release targets).
  // target_commitish may be a branch name (e.g. "main") or a commit SHA.
  // Branch names are resolved by validateBaseRef via git rev-parse; if the
  // branch doesn't exist locally the normal fallback chain takes over.
  //
  // Validated against a safe-ref charset: an attacker-controlled target_commitish
  // that resolves to an unrelated commit could produce a misleading diff —
  // we fail through to HEAD~1 rather than diff the wrong base.
  if (eventName === "release") {
    const targetRef = payload.release?.target_commitish;
    if (targetRef && typeof targetRef === "string") {
      const trimmed = targetRef.trim();
      // Accept: 7-64 hex chars (commit SHA), or a branch/tag name composed of
      // alphanumeric, dot, underscore, hyphen, and slash. Reject a leading `-`
      // (option injection) and any other characters outside this charset.
      // `..` is excluded from a plain charset check — the charset above allows `.`
      // for legitimate refs like "release/1.0", but a `..` segment (e.g. "main/../../other")
      // is a path-traversal-style ref that could resolve outside the intended branch/tag.
      const SAFE_REF_RE = /^(?:[0-9a-f]{7,64}|[a-zA-Z0-9][a-zA-Z0-9_./-]*)$/;
      if (trimmed && !trimmed.startsWith("-") && !trimmed.includes("..") && SAFE_REF_RE.test(trimmed)) {
        core.info(`Auto-detected base ref from release target: ${trimmed}`);
        return trimmed;
      }
      if (trimmed) {
        core.warning(
          `release.target_commitish ${JSON.stringify(trimmed)} contains unsafe characters — ` +
          `falling back to HEAD~1 to avoid diffing an attacker-controlled base ref`,
        );
      }
    }
  }

  // schedule, workflow_dispatch, workflow_call, workflow_run, and others
  // These events don't have a natural "before" SHA.
  // Fall through to default resolution below.

  core.info("Could not auto-detect base ref, falling back to HEAD~1");
  return "HEAD~1";
}

/**
 * Validate the resolved base ref actually exists in the repo.
 * Falls back to HEAD~1, then origin/main, then the empty tree.
 */
export async function validateBaseRef(ref: string): Promise<string> {
  if (await refExists(ref)) return ref;
  core.warning(`Base ref '${ref}' not found in repo`);

  const parent = await getParentSha();
  if (parent) {
    core.info(`Falling back to parent commit: ${parent}`);
    return parent;
  }

  if (await refExists("origin/main")) {
    core.info("Falling back to origin/main");
    return "origin/main";
  }

  // Initial commit — nothing to diff against
  core.info("No valid base ref found — using empty tree (initial commit)");
  return EMPTY_TREE;
}

async function isShallowRepo(): Promise<boolean> {
  let output = "";
  const exitCode = await exec.exec(
    "git",
    ["rev-parse", "--is-shallow-repository"],
    {
      listeners: { stdout: (data) => (output += data.toString()) },
      silent: true,
      ignoreReturnCode: true,
    },
  );
  return exitCode === 0 && output.trim() === "true";
}

async function canDiffCommits(ref: string): Promise<boolean> {
  const exitCode = await exec.exec(
    "git",
    ["diff", "--no-patch", ref, "HEAD"],
    { silent: true, ignoreReturnCode: true },
  );
  return exitCode === 0;
}

export type DiffPlan =
  | { mode: "git"; baseRef: string }
  | { mode: "api"; baseSha: string; headSha: string };

async function revParse(ref: string): Promise<string | null> {
  let output = "";
  const exitCode = await exec.exec(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    {
      listeners: { stdout: (data) => (output += data.toString()) },
      silent: true,
      ignoreReturnCode: true,
    },
  );
  return exitCode === 0 ? output.trim() : null;
}

async function fetchBySha(sha: string): Promise<void> {
  await exec.exec("git", ["fetch", "origin", sha, "--depth=1"], {
    silent: true,
    ignoreReturnCode: true,
  });
}

async function countCommits(): Promise<number> {
  let output = "";
  await exec.exec("git", ["rev-list", "--count", "HEAD"], {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
    ignoreReturnCode: true,
  });
  return parseInt(output.trim(), 10) || 0;
}

async function deepenLoop(maxRetries: number): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const before = await countCommits();
    await exec.exec("git", ["fetch", "--deepen=100", "origin"], {
      silent: true,
      ignoreReturnCode: true,
    });
    if (!(await isShallowRepo())) break; // shallow boundary reached
    const after = await countCommits();
    if (after <= before) break; // no new commits fetched
  }
}

function resolveHeadSha(): string {
  const { eventName, payload, sha } = github.context;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const prHead = payload.pull_request?.head?.sha;
    if (prHead) return prHead;
  }
  return sha || "";
}

export async function makeBaseRefDiffable(
  rawRef: string,
  opts: { fetchRetries: number },
): Promise<DiffPlan> {
  if (rawRef === EMPTY_TREE) return { mode: "git", baseRef: EMPTY_TREE };

  // For push events, distrust the before-SHA if the push was forced.
  // A force-push rewrites history, so `before` is no longer an ancestor of HEAD —
  // diffing against it would produce a misleading (possibly enormous) changed-file set.
  // Degrade to check-all (EMPTY_TREE) so we fail-closed rather than under-checking.
  const { eventName, payload } = github.context;
  if (eventName === "push" && payload.forced === true) {
    core.warning(
      "Forced push detected — before-SHA is no longer an ancestor of HEAD. " +
      "Falling back to check-all (empty tree) to avoid missing changed packages.",
    );
    return { mode: "git", baseRef: EMPTY_TREE };
  }

  // Pre-compute head SHA for API mode. If absent (non-Actions CLI context), any API
  // plan would produce a malformed compareCommits call, so degrade to EMPTY_TREE instead.
  const headSha = resolveHeadSha();
  const toApiPlan = (baseSha: string): DiffPlan =>
    headSha
      ? { mode: "api", baseSha, headSha }
      : { mode: "git", baseRef: EMPTY_TREE };

  // HEAD-prefixed refs (HEAD~1, HEAD^, etc.): deepen first, then resolve to a concrete SHA
  if (rawRef.startsWith("HEAD")) {
    if (await isShallowRepo()) {
      await deepenLoop(opts.fetchRetries);
    }
    const sha = await revParse(rawRef);
    if (!sha) {
      core.info("No parent commit found — using empty tree (initial commit)");
      return { mode: "git", baseRef: EMPTY_TREE };
    }
    if (await canDiffCommits(sha)) {
      return { mode: "git", baseRef: sha };
    }
    return toApiPlan(sha);
  }

  // origin/ refs are always locally accessible
  if (rawRef.startsWith("origin/")) {
    if (await canDiffCommits(rawRef)) return { mode: "git", baseRef: rawRef };
    return toApiPlan(rawRef);
  }

  // Concrete SHA or branch ref: check if already locally available
  if ((await refExists(rawRef)) && (await canDiffCommits(rawRef))) {
    return { mode: "git", baseRef: rawRef };
  }

  // Not available locally; try to fetch it if repo is shallow
  if (await isShallowRepo()) {
    await fetchBySha(rawRef);
    await deepenLoop(opts.fetchRetries);
  }

  if (await canDiffCommits(rawRef)) {
    return { mode: "git", baseRef: rawRef };
  }

  // Cannot recover locally — use GitHub API to diff
  return toApiPlan(rawRef);
}
