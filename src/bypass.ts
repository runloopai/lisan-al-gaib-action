import * as exec from "@actions/exec";
import * as github from "@actions/github";

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

/**
 * Events where a human authored the push interactively and is present at run time.
 * Exported so callers (e.g. the bypass hint in main.ts) can match the same set
 * rather than duplicating it and risking drift.
 */
export const INTERACTIVE_PUSH_EVENTS = new Set(["push"]);

export function isPrEvent(): boolean {
  return PR_EVENTS.has(github.context.eventName);
}

/**
 * Check whether the bypass keyword is present via the appropriate source for the event type.
 *
 * On pull_request / pull_request_target: accepted ONLY as a PR label (contributor-editable
 * sources like PR body and commit messages are rejected).
 *
 * On push events: accepted from the HEAD commit message, or from a label on any PR
 * associated with the HEAD commit (via the GitHub API when a token is available).
 *
 * On unattended events (schedule, workflow_dispatch, workflow_run, etc.): commit-message
 * bypass is DISABLED because no human is present at run time — a pre-planted keyword would
 * silently skip every future unattended run. Only the PR-label path is accepted.
 */
export async function checkBypass(keyword: string, token: string): Promise<boolean> {
  if (isPrEvent()) {
    const labels = github.context.payload.pull_request?.labels as
      | Array<{ name: string }>
      | undefined;
    return labels?.some((l) => l.name === keyword) ?? false;
  }

  // Interactive push events: HEAD commit message is authored by the pusher at push time —
  // it is not a pre-planted keyword that persists across future runs of the same workflow.
  if (INTERACTIVE_PUSH_EVENTS.has(github.context.eventName)) {
    try {
      let msg = "";
      await exec.exec("git", ["log", "-1", "--format=%B"], {
        listeners: { stdout: (data) => (msg += data.toString()) },
        silent: true,
      });
      if (msg.split("\n").map((l) => l.trim()).includes(keyword)) return true;
    } catch {
      // git not available
    }
  }

  // All events: look for a label on an associated PR (requires a human to have applied it).
  if (token) {
    try {
      const octokit = github.getOctokit(token);
      const { owner, repo } = github.context.repo;
      const { data: prs } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: github.context.sha,
        });
      if (prs.some((pr) => pr.labels.some((l) => l.name === keyword))) return true;
    } catch {
      // API call failed
    }
  }

  return false;
}
