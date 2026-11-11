/**
 * What a CONFLICT answer means. Review CONF-12 (2026-11-11): the daily
 * close took every CONFLICT for "someone else changed this", including the
 * two the idempotency middleware (apps/api/src/trpc/trpc.ts) answers for
 * reasons of its own. A slow save, retried while the first attempt was
 * still being written, showed the conflict banner and offered a reload.
 */
export type ConflictKind =
  /** The record changed since the screen read it (an old version or sequence). */
  | 'stale'
  /** The first attempt with this idempotency key is still being processed. */
  | 'inFlight'
  /** The key came back with different content; nothing was saved. */
  | 'keyReused';

/**
 * The server's key for "changed since you read it". settlement.save answers
 * it too: the daily close shares the order's sentence. A key of its own
 * waits until the Fine app, which calls the same API, is checked for it.
 */
const STALE_KEY = 'order.errors.staleSeq';

export function conflictKind(error: unknown): ConflictKind | null {
  const e = error as { data?: { code?: unknown }; message?: unknown } | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : undefined;
  if (message === STALE_KEY) return 'stale';
  if (e?.data?.code !== 'CONFLICT') return null;
  if (message === 'common.errors.requestInFlight') return 'inFlight';
  if (message === 'common.errors.idempotencyKeyReused') return 'keyReused';
  return null;
}
