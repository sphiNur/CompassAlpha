/**
 * The realtime channel: the messages the API's hub pushes and the codes it
 * closes a socket with, read by the hub and the web's socket alike (review
 * COREWEB2-24: each side kept its own copy, and they had drifted; the web
 * did not know 4003, so a removed member reconnected every 30 s for good).
 *
 * No zod here: the web imports this module, and a schema module would
 * bring all of zod with it (P-5, see limits.ts).
 */

/** What changed in the catalog. */
export type CatalogEntity = 'store' | 'sku' | 'supplier' | 'category' | 'expenseTemplate';

/** A push: "something changed, read it again", never the change itself. */
export type RealtimeMessage =
  | { type: 'order.changed'; orgId: string; sessionId: string; lastSeq: number }
  | { type: 'run.changed'; orgId: string; runId: string; lastSeq: number }
  | { type: 'catalog.changed'; orgId: string; entity: CatalogEntity }
  | { type: 'people.changed'; orgId: string }
  | { type: 'attendance.changed'; orgId: string; storeId: string }
  | { type: 'settlement.changed'; orgId: string; storeId: string }
  | { type: 'ping'; t: number };

/** The pushes that make data stale, as opposed to the keep-alive ping. */
export type RealtimeChange = Exclude<RealtimeMessage['type'], 'ping'>;

/** Sent to the oldest socket of a workspace at its connection cap, just before it is closed. */
export interface EvictionNotice {
  type: 'evicted';
  reason: string;
}

/** The workspace's connection cap was reached and this, the oldest socket, was dropped. */
export const WS_CLOSE_EVICTED = 4000;

/** The access token expired: refresh it; a new one opens a new socket. */
export const WS_CLOSE_TOKEN_EXPIRED = 4001;

/**
 * The member was suspended or removed (security scan F7, 2026-10-31). The
 * upgrade refuses them, so reconnecting with the same session cannot work.
 */
export const WS_CLOSE_MEMBERSHIP_ENDED = 4003;
