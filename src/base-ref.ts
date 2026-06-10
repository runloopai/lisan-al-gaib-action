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
  return /^0{40}$/.test(sha);
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

  // release — use the target commitish (branch/tag the release targets)
  if (eventName === "release") {
    const targetRef = payload.release?.target_commitish;
    if (targetRef) {
      core.info(`Auto-detected base ref from release target: ${targetRef}`);
      return targetRef;
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

  // For push events, distrust the before-SHA if the push was forced
  let ref = rawRef;
  const { eventName, payload } = github.context;
  if (eventName === "push" && payload.forced === true) {
    core.info("Forced push detected — resolving parent commit instead of before-SHA");
    ref = "HEAD~1";
  }

  // Pre-compute head SHA for API mode. If absent (non-Actions CLI context), any API
  // plan would produce a malformed compareCommits call, so degrade to EMPTY_TREE instead.
  const headSha = resolveHeadSha();
  const toApiPlan = (baseSha: string): DiffPlan =>
    headSha
      ? { mode: "api", baseSha, headSha }
      : { mode: "git", baseRef: EMPTY_TREE };

  // HEAD-prefixed refs (HEAD~1, HEAD^, etc.): deepen first, then resolve to a concrete SHA
  if (ref.startsWith("HEAD")) {
    if (await isShallowRepo()) {
      await deepenLoop(opts.fetchRetries);
    }
    const sha = await revParse(ref);
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
  if (ref.startsWith("origin/")) {
    if (await canDiffCommits(ref)) return { mode: "git", baseRef: ref };
    return toApiPlan(ref);
  }

  // Concrete SHA or branch ref: check if already locally available
  if ((await refExists(ref)) && (await canDiffCommits(ref))) {
    return { mode: "git", baseRef: ref };
  }

  // Not available locally; try to fetch it if repo is shallow
  if (await isShallowRepo()) {
    await fetchBySha(ref);
    await deepenLoop(opts.fetchRetries);
  }

  if (await canDiffCommits(ref)) {
    return { mode: "git", baseRef: ref };
  }

  // Cannot recover locally — use GitHub API to diff
  return toApiPlan(ref);
}
