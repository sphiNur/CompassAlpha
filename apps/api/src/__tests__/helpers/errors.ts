/**
 * What a call threw, for the API tests to check (review TEST2-03,
 * TEST2-07, 2026-11). Ten suites had their own copies of these.
 *
 * Each returns null when the call succeeds. A test that expects a refusal
 * then fails, and `toBeNull()` says that a call is allowed.
 *
 * After a failure they wait one turn before returning. A direct tRPC
 * caller can start its next request in the same JavaScript turn, before
 * postgres-js has recycled the transaction that the failure rolled back.
 * Separate HTTP requests always get that boundary. Suites used to add
 * the pause by hand after some failures and not others.
 */

async function failureOf(fn: () => Promise<unknown>): Promise<{ err: unknown } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { err };
  }
}

export interface CallError {
  /** The tRPC code (FORBIDDEN, CONFLICT, …), if the error has one. */
  code?: string;
  message: string;
  /** What the router attached for the log, e.g. `{ reason }`. */
  cause?: unknown;
}

/** The code, message and cause of what `fn` threw; null if it succeeded. */
export async function errorOf(fn: () => Promise<unknown>): Promise<CallError | null> {
  const failure = await failureOf(fn);
  if (!failure) return null;
  const err = failure.err as { code?: string; message?: unknown; cause?: unknown };
  return { code: err.code, message: String(err.message), cause: err.cause };
}

/** The code of what `fn` threw, `'unknown'` if it has none; null if it succeeded. */
export async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  const err = await errorOf(fn);
  return err ? (err.code ?? 'unknown') : null;
}

export interface PgError {
  /** The SQLSTATE (23505, P0001, …); null when the error is not from Postgres. */
  code: string | null;
  message: string;
  constraint: string | null;
}

/**
 * What Postgres said when `fn` failed, out of whatever the ORM wrapped it
 * in: the first error along the `cause` chain that carries a SQLSTATE (as
 * services/pgErrors.ts reads it). An error that is not from Postgres comes
 * back with code null and its own message. Null if `fn` succeeded.
 */
export async function pgErrorOf(fn: () => Promise<unknown>): Promise<PgError | null> {
  const failure = await failureOf(fn);
  if (!failure) return null;
  let current: unknown = failure.err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; constraint_name?: unknown };
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      const constraint = typeof e.constraint_name === 'string' ? e.constraint_name : null;
      return { code: e.code, message: String(e.message), constraint };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {
    code: null,
    message: String((failure.err as { message?: unknown }).message),
    constraint: null,
  };
}
