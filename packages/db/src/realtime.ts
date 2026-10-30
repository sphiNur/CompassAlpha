/**
 * Realtime changes made outside the API process.
 *
 * The API tells open pages about a change through its in-memory hub, but
 * the worker is a separate process with no hub: when it released a stale
 * claim (APR-12/B14), nobody heard, and the reviewer's page kept showing
 * a claim that no longer existed. The worker now announces such a change
 * with Postgres NOTIFY from inside the transaction that makes it, and the
 * API listens on the channel and hands the message to its hub.
 *
 * NOTIFY is transactional: Postgres delivers it after COMMIT and drops it
 * on rollback, so a listener never hears about a change it cannot read
 * yet. Delivery is best-effort (nothing is sent while the API is down);
 * a page that misses it still catches up on its next refetch.
 */
import { sql, type SQL } from 'drizzle-orm';

export const REALTIME_CHANNEL = 'compass_realtime';

/** The messages the worker sends; the same shape as the hub's. */
export type DbRealtimeMessage =
  | { type: 'order.changed'; orgId: string; sessionId: string; lastSeq: number }
  | { type: 'run.changed'; orgId: string; runId: string; lastSeq: number };

/** Announce `message` once the transaction `tx` commits. */
export async function notifyRealtime(
  tx: { execute: (query: SQL) => PromiseLike<unknown> },
  message: DbRealtimeMessage,
): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(message)})`);
}

/** The message in a NOTIFY payload, or null if it is not one of ours. */
export function parseRealtimeNotice(payload: string): DbRealtimeMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (typeof m.orgId !== 'string' || typeof m.lastSeq !== 'number') return null;
  if (m.type === 'order.changed' && typeof m.sessionId === 'string') {
    return { type: 'order.changed', orgId: m.orgId, sessionId: m.sessionId, lastSeq: m.lastSeq };
  }
  if (m.type === 'run.changed' && typeof m.runId === 'string') {
    return { type: 'run.changed', orgId: m.orgId, runId: m.runId, lastSeq: m.lastSeq };
  }
  return null;
}
