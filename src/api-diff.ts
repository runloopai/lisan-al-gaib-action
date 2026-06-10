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
      }): Promise<{ data: { files?: CompareFile[] } }>;
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
  };
};

export function createApiDiffSource(opts: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}): DiffSource {
  const { octokit, owner, repo, baseSha, headSha } = opts;

  const PER_PAGE = 100;
  let cachedFiles: Promise<CompareFile[]> | null = null;

  function getFiles(): Promise<CompareFile[]> {
    if (!cachedFiles) {
      cachedFiles = (async () => {
        const all: CompareFile[] = [];
        let page = 1;
        while (true) {
          const r = await octokit.rest.repos.compareCommits({
            owner, repo, base: baseSha, head: headSha, per_page: PER_PAGE, page,
          });
          const batch = r.data.files ?? [];
          all.push(...batch);
          if (batch.length < PER_PAGE) break;
          page++;
        }
        return all;
      })();
      // Don't cache rejected promises — allow retry on next call
      // Clear cache on rejection so a subsequent caller can retry.
      // Safe because callers are sequential (main.ts warm call runs before any ecosystem).
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
      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: file,
          ref: baseSha,
        });
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
      } catch {
        return null;
      }
    },
  };
}
