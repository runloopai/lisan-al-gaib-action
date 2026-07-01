import * as core from "@actions/core";

/**
 * Run tasks in groups of `batchSize` concurrently via Promise.allSettled.
 * Rejections are logged via `logger` (so transient failures are visible) but do
 * NOT throw — each task is expected to record its own result via closure.
 *
 * @param logger Optional callback for failure messages; defaults to `core.warning`.
 */
export async function runBatched(
  tasks: Array<() => Promise<void>>,
  batchSize: number,
  logger?: (message: string) => void,
): Promise<void> {
  const log = logger ?? ((msg) => core.warning(msg));
  // Guard against batchSize <= 0: i += 0 would infinite-loop; i += negative would underflow.
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 1;
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size);
    const settled = await Promise.allSettled(batch.map((t) => t()));
    for (const s of settled) {
      if (s.status === "rejected") {
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        log(`[lisan] batched task failed: ${reason}`);
      }
    }
  }
}
