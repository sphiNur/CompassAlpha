/**
 * Realtime notices sent after an admin change, so other admins' screens
 * refetch. Each carries only what changed, not the rows.
 */
import { hub } from '../../../realtime/hub';

/**
 * Broadcast a catalog change so other admins viewing People/Catalog
 * pages auto-refresh. Coarse — payload only carries the entity kind,
 * the client just invalidates `[admin.<list>]` queries.
 */
export function broadcastCatalog(
  orgId: string,
  entity: 'store' | 'sku' | 'supplier' | 'category' | 'expenseTemplate',
): void {
  hub.publish(orgId, { type: 'catalog.changed', orgId, entity });
}

export function broadcastPeople(orgId: string): void {
  hub.publish(orgId, { type: 'people.changed', orgId });
}

/**
 * CAT-6 (2026-10-30): after a purge, open order and run pages kept
 * showing the deleted rows until someone acted on one ("not found").
 * Clients refetch on the message type, so one of each is enough; the ids
 * are a hint (the org id when a whole workspace went).
 */
export function broadcastPurged(orgId: string, sessionIds: string[], runIds: string[]): void {
  hub.publish(orgId, {
    type: 'order.changed',
    orgId,
    sessionId: sessionIds[0] ?? orgId,
    lastSeq: -1,
  });
  hub.publish(orgId, { type: 'run.changed', orgId, runId: runIds[0] ?? orgId, lastSeq: -1 });
}
