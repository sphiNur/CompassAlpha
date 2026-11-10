/**
 * Jobs the API process runs on a timer, and waiting for them at shutdown
 * (COREAPI-13/14, 2026-11-09).
 *
 * The attendance photo and frame-print retention ran in the `.then` of
 * the reminder scan, so a scan that failed skipped them, and kept
 * skipping them while the failure lasted: photos outlived the retention
 * the product promises. Shutdown cleared one timer of two and closed the
 * database under whatever was running. Each job now has its own timer
 * and its own catch, and `stop()` waits for a run in progress.
 */

export interface PeriodicJob {
  /** Run now, unless a run is still in progress (runs never overlap). */
  tick(): void;
  /** No further runs; resolves when the run in progress, if any, ends. */
  stop(): Promise<void>;
}

/**
 * Run `run` every `ms`. A failure is logged with the job's name and the
 * next tick runs as usual.
 */
export function every(
  name: string,
  ms: number,
  run: () => Promise<void>,
  log: { warn: (obj: object, msg: string) => void },
): PeriodicJob {
  let current: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || current) return;
    current = Promise.resolve()
      .then(run)
      .catch((err: unknown) => log.warn({ err, job: name }, 'periodic job failed'))
      .finally(() => {
        current = null;
      });
  };
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}

/** Whether `work` settles within `ms` (its failure counts as settled). */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
