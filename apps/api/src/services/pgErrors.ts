/**
 * Reading what Postgres said out of whatever the ORM threw.
 *
 * postgres.js throws an error whose own `code` is the SQLSTATE. Since
 * drizzle-orm 0.45, a query made through the ORM throws a
 * `DrizzleQueryError` instead: its message is the SQL text and the
 * driver's error is its `cause`. Raw `sql\`…\`` on the client is still
 * unwrapped. So the SQLSTATE can sit on the error or one or more causes
 * down, and a check that looks only at the top misses it silently: the
 * conflict it was written to translate becomes an unhandled 500.
 */

const MAX_DEPTH = 5;

/** The first SQLSTATE found on the error or along its `cause` chain. */
export function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < MAX_DEPTH; depth += 1) {
    const code = (current as { code?: unknown }).code;
    // SQLSTATE is five characters; Node's own codes (ECONNRESET) are not.
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * unique_violation. For the event store this is two writers appending the
 * same sequence number to one stream: the loser must be told to reload,
 * not shown a server error.
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}
