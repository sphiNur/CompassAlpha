/**
 * Table locks during a migration (review DB-08, 2026-11-10).
 *
 * The deploy migrates while the old API still serves, and
 * 900_rls_policies.sql alone takes an ACCESS EXCLUSIVE lock on every
 * tenant table it touches (ENABLE/FORCE RLS, DROP and CREATE POLICY).
 * Nothing limited the wait for such a lock: behind one long transaction
 * (a slow query, an idle connection left in a transaction, the nightly
 * pg_dump) the migration waited, and every read and write of that table
 * queued behind the migration, so the app stood still until the long
 * transaction ended.
 *
 * The runner's session now gives up on a lock after LOCK_TIMEOUT, so the
 * app waits that long at most, and the step is tried again after a pause.
 * Every step it retries rolls back whole on failure: the drizzle batch
 * runs in one transaction, and each raw SQL file is one implicit
 * transaction that is safe to run again.
 */

/** How long one statement of a migration waits for a lock. */
export const LOCK_TIMEOUT = '3s';

/** The pauses before each new try of a step whose lock wait ran out. */
export const LOCK_RETRY_PAUSES_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000];

/** SQLSTATE lock_not_available: a lock wait ran past lock_timeout. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Whether `err` is a lock wait that ran out. Drizzle wraps the driver's
 * error in its own, with the original as `cause`.
 */
export function isLockTimeout(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs `step`, again after each pause in `pausesMs` while it fails on a
 * lock wait; any other failure, or the last one, is thrown.
 */
export async function retryOnLockTimeout<T>(
  what: string,
  step: () => Promise<T>,
  opts: {
    pausesMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<T> {
  const pauses = opts.pausesMs ?? LOCK_RETRY_PAUSES_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      const pause = pauses[attempt];
      if (pause === undefined || !isLockTimeout(err)) throw err;
      log(
        `  ↻ ${what}: a table stayed locked past ${LOCK_TIMEOUT}; nothing was kept, trying again in ${pause / 1000} s`,
      );
      await sleep(pause);
    }
  }
}
