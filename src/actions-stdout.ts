/**
 * Shared stdout handling for the local CLIs (verify's `cli.ts` and the updater's
 * `update/cli.ts`). @actions/core writes GitHub Actions workflow commands
 * (`::error::`, `::warning::`, etc.) directly to `process.stdout` regardless of
 * whether a real Actions runner is present to interpret them — outside Actions
 * these are meaningless noise on stdout at best, and at worst corrupt output a
 * CLI consumer expects to be pure (e.g. `update --json`).
 */

type WriteFn = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
  cb?: (err?: Error | null) => void,
) => boolean;

// Captured at module load time, before installActionsCommandFilter() ever patches
// process.stdout.write — so writeRawStdout can always reach the real stdout even
// after the filter below is installed.
const pristineStdoutWrite: WriteFn = process.stdout.write.bind(process.stdout) as WriteFn;

/**
 * Write text directly to the real stdout, bypassing any filter installed by
 * {@link installActionsCommandFilter}. Use this for output that must never be
 * redirected or swallowed — e.g. `update --json`'s final JSON payload.
 */
export function writeRawStdout(text: string): void {
  pristineStdoutWrite(text);
}

/**
 * When running outside GitHub Actions, intercept @actions/core's workflow
 * commands on stdout and render them as colored, human-readable lines on
 * stderr instead. All other string content written to stdout is redirected to
 * stderr too — neither CLI has a legitimate reason to write plain diagnostic
 * text to stdout, and this keeps stdout clean for output that does (piped
 * results, `--json`, written via {@link writeRawStdout}).
 *
 * No-op when GITHUB_ACTIONS is set: inside a real Actions runner these lines
 * are the actual annotation protocol and must reach the genuine stdout.
 */
export function installActionsCommandFilter(): void {
  if (process.env.GITHUB_ACTIONS) return;

  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const stderrWrite = process.stderr.write.bind(process.stderr) as WriteFn;

  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    if (typeof chunk === "string") {
      if (chunk.startsWith("::error")) {
        const msg = chunk.replace(/^::error\s*[^:]*::/, "").trim();
        return stderrWrite(red(`ERROR: ${msg}`) + "\n");
      }
      if (chunk.startsWith("::warning")) {
        const msg = chunk.replace(/^::warning\s*[^:]*::/, "").trim();
        return stderrWrite(yellow(`WARN:  ${msg}`) + "\n");
      }
      if (chunk.startsWith("::debug::")) return true;
      if (chunk.startsWith("::group::")) {
        return stderrWrite("\n" + chunk.replace("::group::", "").trim() + "\n");
      }
      if (chunk.startsWith("::endgroup::")) return true;
      if (chunk.startsWith("::set-output")) return true;
      // All other @actions/core output (info, etc.) → stderr
      return stderrWrite(chunk, typeof encodingOrCb === "function" ? undefined : encodingOrCb);
    }
    if (typeof encodingOrCb === "function") {
      return pristineStdoutWrite(chunk, undefined, encodingOrCb);
    }
    return pristineStdoutWrite(chunk, encodingOrCb, cb);
  } as typeof process.stdout.write;
}
