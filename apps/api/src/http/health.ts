/**
 * GET /health/ready: whether this api can serve traffic, for the deploy
 * (scripts/lib/liveSite.ts waits for a 200) and any load balancer.
 *
 * Hardened 2026-05-05: it answered `ok` unconditionally, so traffic went
 * to an instance whose database connection had died. It now makes one
 * round trip to the database and answers 503 when that fails.
 *
 * Review COREAPI-21 (2026-11-12): the endpoint is public, and the 503 body
 * carried the database error's message, which can name the host, the
 * database or the role. The cause is logged; the body says only which part
 * is down. The projector lag it also reported was read from a table that
 * nothing writes (COREAPI-29), so it was always null: gone.
 */
import type { Context } from 'hono';

export interface ReadinessDeps {
  /** One round trip to the database; rejects when it cannot be made. */
  pingDb: () => Promise<unknown>;
  /** The web build this api serves. */
  version: () => string;
  /** Where the cause of a failed ping goes (the log). */
  onDbError: (err: unknown) => void;
}

export function readinessHandler(deps: ReadinessDeps) {
  return async (c: Context) => {
    const start = Date.now();
    try {
      await deps.pingDb();
    } catch (err) {
      deps.onDbError(err);
      return c.json({ status: 'down', component: 'db' }, 503);
    }
    return c.json({ status: 'ok', version: deps.version(), dbMs: Date.now() - start });
  };
}
