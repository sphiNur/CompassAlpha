/**
 * Realtime hub.
 *
 * Manages a per-org Set of attached WebSocket sinks. The order/run routers
 * call `hub.publish(orgId, 'order.changed' | 'run.changed', payload)` after
 * a successful projection so connected clients can refetch their queries.
 *
 * B9 (2026-10-30): those calls sit inside the transaction that wrote the
 * change, so `publish` defers the send until that transaction commits
 * (and drops it on rollback); see `afterCommit` in @compass/db. A client
 * that refetches on the message now always reads what it announces.
 * Changes made by the worker process arrive through Postgres NOTIFY
 * (dbRelay.ts), which Postgres itself only delivers on commit.
 *
 * This M1 implementation is intentionally simple — it only does broadcast
 * fan-out within a single API process. M2 swaps the in-memory Map for a
 * Redis pub/sub channel so multi-instance deploys converge.
 *
 * Authentication: `subscribe(orgId, send)` is called *after* the WS
 * upgrade handler has validated the connection's bearer ticket. The hub
 * itself has no opinion on auth.
 */

import { afterCommit } from '@compass/db';

export type RealtimeMessage =
  | { type: 'order.changed'; orgId: string; sessionId: string; lastSeq: number }
  | { type: 'run.changed'; orgId: string; runId: string; lastSeq: number }
  // Admin-side mutations (added 2026-05-03). Coarse channels — the
  // client invalidates the whole admin.* query family on receive
  // because catalog/people pages re-fetch quickly and the broadcast
  // payload here is a "something changed" hint, not a delta.
  //
  //   catalog.changed: stores, skus, suppliers, categories, expenseTemplates
  //   people.changed:  members, role bindings, store assignments
  | {
      type: 'catalog.changed';
      orgId: string;
      entity: 'store' | 'sku' | 'supplier' | 'category' | 'expenseTemplate';
    }
  | { type: 'people.changed'; orgId: string }
  | { type: 'notification'; orgId: string; userId: string; title: string; body?: string }
  | { type: 'ping'; t: number };

type Send = (data: string) => void;
/** Closes the sink's socket with the given WS close code. */
type Close = (code: number) => void;

/**
 * Per-org connection cap (M1.22, 2026-05-08, launch hardening).
 *
 * Without a cap, a single org could accumulate thousands of stale
 * WebSocket sinks if clients fail to close cleanly — every broadcast
 * then iterates the dead set, serialising the JSON payload N times.
 * Bounding the set at 1000 covers any plausible legitimate scale (a
 * 100-store chain × 10 active staff per store = 1000) while making
 * a leak self-limiting.
 *
 * When the cap is hit, the OLDEST connection is evicted (FIFO via
 * the Set's insertion order). This bias keeps fresh tabs working and
 * sheds zombies first. Evicted connection's `send` is called with a
 * sentinel close message so the FE can log and reconnect cleanly.
 *
 * 2026-10-21 audit CA-35/F-08: eviction used to only drop the sink from
 * the Set and leave the socket open — a zombie the client still believed
 * was live, receiving nothing. The caller now passes `close`, which the
 * hub calls right after the notice (main.ts closes with code 4000).
 */
const MAX_CONNECTIONS_PER_ORG = 1000;
const EVICTION_NOTICE = JSON.stringify({
  type: 'evicted',
  reason: 'org connection cap reached',
});

/** Close code the WS layer uses for an evicted connection. */
export const WS_CLOSE_EVICTED = 4000;

/**
 * Close code for a socket whose member was suspended or removed
 * (security scan F7, 2026-10-31). The client's ordinary reconnect is
 * then refused at the upgrade, which re-checks the membership.
 */
export const WS_CLOSE_MEMBERSHIP_ENDED = 4003;

class Hub {
  private readonly subs = new Map<string, Set<Send>>();
  private readonly closers = new WeakMap<Send, Close>();
  /** The member each sink belongs to, for `closeMember`. */
  private readonly members = new WeakMap<Send, string>();

  subscribe(orgId: string, send: Send, close?: Close, memberId?: string): () => void {
    let set = this.subs.get(orgId);
    if (!set) {
      set = new Set();
      this.subs.set(orgId, set);
    }
    // M1.22: evict the oldest connection if we'd exceed the cap.
    // Set iteration is insertion-order in V8 / Bun, so the first
    // entry is the oldest.
    while (set.size >= MAX_CONNECTIONS_PER_ORG) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      set.delete(oldest);
      try {
        oldest(EVICTION_NOTICE);
      } catch {
        /* dead sink — already gone */
      }
      try {
        this.closers.get(oldest)?.(WS_CLOSE_EVICTED);
      } catch {
        /* already closed */
      }
      this.closers.delete(oldest);
    }
    set.add(send);
    if (close) this.closers.set(send, close);
    if (memberId) this.members.set(send, memberId);
    return () => {
      const s = this.subs.get(orgId);
      this.closers.delete(send);
      this.members.delete(send);
      if (!s) return;
      s.delete(send);
      if (s.size === 0) this.subs.delete(orgId);
    };
  }

  /**
   * Close every socket the member has open in the org once the current
   * transaction commits (security scan F7, 2026-10-31). Membership is
   * checked when a socket opens; without this a member suspended or
   * removed kept receiving the org's change events until the access
   * token ran out (up to 15 minutes).
   */
  closeMember(orgId: string, memberId: string): void {
    afterCommit(() => this.closeMemberNow(orgId, memberId));
  }

  private closeMemberNow(orgId: string, memberId: string): void {
    const set = this.subs.get(orgId);
    if (!set) return;
    for (const send of [...set]) {
      if (this.members.get(send) !== memberId) continue;
      set.delete(send);
      const close = this.closers.get(send);
      this.closers.delete(send);
      this.members.delete(send);
      try {
        close?.(WS_CLOSE_MEMBERSHIP_ENDED);
      } catch {
        /* already closed */
      }
    }
    if (set.size === 0) this.subs.delete(orgId);
  }

  /** Send to the org's sockets once the current transaction commits. */
  publish(orgId: string, message: RealtimeMessage): void {
    afterCommit(() => this.deliver(orgId, message));
  }

  private deliver(orgId: string, message: RealtimeMessage): void {
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

  /**
   * Broadcast an app-level keepalive to every connected sink across
   * every org (M3.8, 2026-05-15). Called on a fixed interval from
   * main.ts so idle WebSockets keep flowing bytes through edge
   * proxies (Cloudflare, nginx) that otherwise close connections
   * after ~60s of silence.
   *
   * Bun's ServerWebSocket.send is sync + non-blocking. A dead sink
   * just throws inside the inner try; we swallow because the close()
   * handler will run shortly after on the same socket and clean the
   * Set entry. No per-org overhead when an org has no subs.
   */
  pingAll(): number {
    if (this.subs.size === 0) return 0;
    const payload = JSON.stringify({ type: 'ping', t: Date.now() });
    let pinged = 0;
    for (const set of this.subs.values()) {
      for (const send of set) {
        try {
          send(payload);
          pinged++;
        } catch {
          /* dead sink — will be cleaned up by the close handler */
        }
      }
    }
    return pinged;
  }
}

export const hub = new Hub();
