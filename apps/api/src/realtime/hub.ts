/**
 * Realtime hub.
 *
 * Manages a per-org Set of attached WebSocket sinks. The order/run routers
 * call `hub.publish(orgId, 'order.changed' | 'run.changed', payload)` after
 * a successful projection so connected clients can refetch their queries.
 *
 * This M1 implementation is intentionally simple — it only does broadcast
 * fan-out within a single API process. M2 swaps the in-memory Map for a
 * Redis pub/sub channel so multi-instance deploys converge.
 *
 * Authentication: `subscribe(orgId, send)` is called *after* the WS
 * upgrade handler has validated the connection's bearer ticket. The hub
 * itself has no opinion on auth.
 */

export type RealtimeMessage =
  | { type: 'order.changed'; orgId: string; sessionId: string; lastSeq: number }
  | { type: 'run.changed'; orgId: string; runId: string; lastSeq: number }
  // Admin-side mutations (added 2026-05-03). Coarse channels — the
  // client invalidates the whole admin.* query family on receive
  // because catalog/people pages re-fetch quickly and the broadcast
  // payload here is a "something changed" hint, not a delta.
  //
  //   catalog.changed: stores, skus, suppliers, categories
  //   people.changed:  members, role bindings, store assignments
  | { type: 'catalog.changed'; orgId: string; entity: 'store' | 'sku' | 'supplier' | 'category' }
  | { type: 'people.changed'; orgId: string }
  | { type: 'notification'; orgId: string; userId: string; title: string; body?: string }
  | { type: 'ping'; t: number };

type Send = (data: string) => void;

class Hub {
  private readonly subs = new Map<string, Set<Send>>();

  subscribe(orgId: string, send: Send): () => void {
    let set = this.subs.get(orgId);
    if (!set) {
      set = new Set();
      this.subs.set(orgId, set);
    }
    set.add(send);
    return () => {
      const s = this.subs.get(orgId);
      if (!s) return;
      s.delete(send);
      if (s.size === 0) this.subs.delete(orgId);
    };
  }

  publish(orgId: string, message: RealtimeMessage): void {
    const set = this.subs.get(orgId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(message);
    for (const send of set) {
      try {
        send(payload);
      } catch {
        // Sink threw — likely a closed socket. Caller cleans it up via the
        // unsubscribe returned from subscribe(); we just skip.
      }
    }
  }

  size(orgId?: string): number {
    if (orgId) return this.subs.get(orgId)?.size ?? 0;
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }

  // Useful for tests + /debug.
  orgCount(): number {
    return this.subs.size;
  }
}

export const hub = new Hub();
