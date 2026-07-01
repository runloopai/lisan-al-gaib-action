import type { DiffSource } from "./diff.js";

type CompareFile = {
  filename: string;
  status: string;
  previous_filename?: string;
};

type ContentData = {
  type: string;
  content?: string;
  encoding?: string;
  download_url?: string | null;
};

type OctokitLike = {
  rest: {
    repos: {
      compareCommits(params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
        per_page: number;
        page: number;
      }): Promise<{ data: { files?: CompareFile[]; total_commits?: number } }>;
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
  };
};

/**
 * GitHub's compareCommits API silently caps the `files` array at ~300 entries
 * when the diff is large (pull requests with many changed files, lock-file
 * regenerations, etc.). We throw whenever the accumulated file count reaches
 * GITHUB_FILE_CAP (300), since we cannot distinguish a fully-returned 300-file
 * diff from a truncated one. The caller falls back to check-all mode so no
 * changed lockfiles are silently missed. Fail-closed: a false positive (a real
 * 300-file PR) degrades to over-checking, never under-checking.
 */
const PER_PAGE = 100;
const GITHUB_FILE_CAP = 300;

export function createApiDiffSource(opts: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}): DiffSource {
  const { octokit, owner, repo, baseSha, headSha } = opts;

  let cachedFiles: Promise<CompareFile[]> | null = null;

  function getFiles(): Promise<CompareFile[]> {
    if (!cachedFiles) {
      cachedFiles = (async () => {
        const all: CompareFile[] = [];
        let page = 1;
        let totalCommits = 0;
        while (true) {
          const r = await octokit.rest.repos.compareCommits({
            owner, repo, base: baseSha, head: headSha, per_page: PER_PAGE, page,
          });
          const batch = r.data.files ?? [];
          // Capture total_commits for the informational error message below.
          if (page === 1) totalCommits = r.data.total_commits ?? 0;
          all.push(...batch);
          if (batch.length < PER_PAGE) break;
          page++;
          // GitHub caps the files list at GITHUB_FILE_CAP entries across all pages.
          // When we've accumulated that many, any further items would be silently dropped.
          // Detect and throw so the caller can fall back to check-all mode.
          if (all.length >= GITHUB_FILE_CAP) {
            throw new Error(
              `compareCommits file list is truncated (${all.length}+ files, ` +
              `${totalCommits} commits): falling back to check-all mode to avoid missing changed lockfiles`,
            );
          }
        }
        return all;
      })();
      // Clear the cache on rejection so a subsequent caller can retry.
      cachedFiles.catch(() => { cachedFiles = null; });
    }
    return cachedFiles;
  }

  return {
    async diff(file: string): Promise<string> {
      const files = await getFiles();
      const found = files.some((f) => f.filename === file);
      return found ? "changed" : "";
    },

    async diffNameOnly(): Promise<string[]> {
      const files = await getFiles();
      return files.map((f) => f.filename);
    },

    async diffFiltered(filter: string): Promise<string[]> {
      const files = await getFiles();
      // For filter "A" (added), return only files with status "added".
      // Intentionally exclude "renamed" to match git --diff-filter=A semantics
      // (renames are not considered truly added).
      if (filter === "A") {
        return files.filter((f) => f.status === "added").map((f) => f.filename);
      }
      // Other filters are not currently used by the action; return all changed files
      return files.map((f) => f.filename);
    },

    async showFile(file: string): Promise<string | null> {
      // 404 = file legitimately absent at baseSha (newly added file) → null is correct.
      // 5xx / network errors are transient and should propagate so callers can fail-closed.
      let response: Awaited<ReturnType<typeof octokit.rest.repos.getContent>>;
      try {
        response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: file,
          ref: baseSha,
        });
      } catch (err: unknown) {
        // Octokit throws `RequestError` for HTTP errors; check the status field.
        const status = (err as { status?: number })?.status;
        if (status === 404) return null; // file didn't exist at base — legitimately absent
        // 5xx / network — propagate to the per-ecosystem try/catch in main.ts which marks
        // that ecosystem as setFailed+continue (fail-closed, never a silent pass).
        // Note: this is a different recovery path than the truncation guard's check-all.
        throw err;
      }

      const data = response.data as ContentData;
      if (data.type !== "file") return null;

      if (data.content && data.encoding === "base64") {
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      }

      // content is empty for files > 1MB — fetch via download_url
      if (data.download_url) {
        const res = await fetch(data.download_url);
        if (!res.ok) return null;
        return res.text();
      }

      return null;
    },
  };
}
