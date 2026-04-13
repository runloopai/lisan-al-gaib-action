import * as github from "@actions/github";
import * as core from "@actions/core";
import * as exec from "@actions/exec";

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
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
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

export async function ensureBaseRefAvailable(ref: string): Promise<string> {
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  if (ref === EMPTY_TREE) return ref;
  if (ref.startsWith("HEAD")) return ref;
  if (ref.startsWith("origin/")) return ref;

  if (!(await isShallowRepo())) return ref;

  if (await canDiffCommits(ref)) return ref;

  core.info(`Shallow clone: base ref ${ref} not diffable, fetching...`);
  await exec.exec("git", ["fetch", "origin", ref, "--depth=1"], {
    silent: true,
    ignoreReturnCode: true,
  });

  if (await canDiffCommits(ref)) return ref;

  core.info("Direct fetch didn't help, trying --deepen=2...");
  await exec.exec(
    "git",
    ["fetch", "--deepen=2", "origin"],
    { silent: true, ignoreReturnCode: true },
  );

  if (await canDiffCommits(ref)) return ref;

  core.warning(
    `Cannot diff against ${ref} even after fetching — falling back to empty tree`,
  );
  return EMPTY_TREE;
}
