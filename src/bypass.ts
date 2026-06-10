import * as exec from "@actions/exec";
import * as github from "@actions/github";

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

export function isPrEvent(): boolean {
  return PR_EVENTS.has(github.context.eventName);
}

/**
 * Check whether the bypass keyword is present via the appropriate source for the event type.
 *
 * On pull_request / pull_request_target: accepted ONLY as a PR label (contributor-editable
 * sources like PR body and commit messages are rejected).
 *
 * On all other events: accepted from the HEAD commit message, or from a label on any PR
 * associated with the HEAD commit (via the GitHub API when a token is available).
 */
export async function checkBypass(keyword: string, token: string): Promise<boolean> {
  if (isPrEvent()) {
    const labels = github.context.payload.pull_request?.labels as
      | Array<{ name: string }>
      | undefined;
    return labels?.some((l) => l.name === keyword) ?? false;
  }

  // Non-PR events: HEAD commit message first
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

  // Then look for a label on an associated PR
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
