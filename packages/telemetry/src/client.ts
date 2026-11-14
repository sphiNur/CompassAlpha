/**
 * Browser logger.
 *
 * Strategy:
 *   - Ring buffer (200 events) for the live `/debug` view.
 *   - In-memory queue (capped) handed to the transport the app sets.
 *   - 5 s flush interval + flush on `pagehide`/`online`/`visibilitychange`.
 *   - Dedupe identical events fired within 200 ms.
 *   - On hide, send what fits in the keepalive quota; keep the rest for the
 *     next start in this tab (MWD-01).
 */
import type { LogEvent, LogLevel, Transport } from './common';
import { BatchRefused, batchBytes, logBatches, sessionId as makeSessionId } from './common';

/** What the logger needs of `sessionStorage` (a test passes its own). */
type KeptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface LoggerConfig {
  appVersion: string;
  flushIntervalMs?: number;
  bufferLimit?: number;
  dedupeWindowMs?: number;
  storageKey?: string;
  /** When false the logger drops debug-level events to keep prod traffic low. */
  includeDebug?: boolean;
  /**
   * The most events, and bytes of JSON, one transport call may carry
   * (COREAPI-04): the server's limits, which the app passes in.
   */
  maxBatchEvents: number;
  maxBatchBytes: number;
  /** Where unsent events wait for the next start; default `sessionStorage`. */
  storage?: KeptStorage | null;
}

const DEFAULTS = {
  flushIntervalMs: 5_000,
  bufferLimit: 200,
  dedupeWindowMs: 200,
  storageKey: 'compass.session',
  includeDebug: true,
};

const MAX_PENDING = 500;

/**
 * Review MWD-01 (modern-web-guidance: batch-analytics-events): browsers
 * refuse a keepalive request once the bodies of those in flight would pass
 * about 64 KiB per origin. The send on hide stays under this, less what is
 * still in flight from an earlier hide.
 */
export const KEEPALIVE_BUDGET_BYTES = 60_000;
/** The most JSON of unsent events kept in storage for the next start. */
const MAX_KEPT_BYTES = 256_000;

class Logger {
  private config: Required<LoggerConfig>;
  private session: string;
  private ring: LogEvent[] = [];
  private pending: LogEvent[] = [];
  private transport: Transport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFingerprint = '';
  private lastAt = 0;
  private listeners = new Set<(events: LogEvent[]) => void>();
  /** Bytes of keepalive bodies sent on hide and not answered yet (MWD-01). */
  private keepaliveBytes = 0;
  private storage: KeptStorage | null;

  constructor(config: LoggerConfig) {
    const storage =
      config.storage !== undefined
        ? config.storage
        : typeof window !== 'undefined'
          ? (window.sessionStorage ?? null)
          : null;
    this.config = { ...DEFAULTS, ...config } as Required<LoggerConfig>;
    this.storage = storage;
    this.session =
      (typeof window !== 'undefined' &&
        window.sessionStorage?.getItem(this.config.storageKey)) ||
      makeSessionId();
    this.pending = this.takeKept();
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem(this.config.storageKey, this.session);
      // flush() catches its own failures (it requeues or drops the batch).
      window.addEventListener('pagehide', () => void this.flush(true));
      window.addEventListener('online', () => void this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush(true);
        // Back in view: the queue in memory is the copy again.
        else this.keep([]);
      });
    }
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
  }

  setTransport(t: Transport): void {
    this.transport = t;
  }

  getSessionId(): string {
    return this.session;
  }

  subscribe(fn: (events: LogEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getRingBuffer(): readonly LogEvent[] {
    return this.ring;
  }

  log(level: LogLevel, kind: string, partial: Omit<LogEvent, 'sessionId' | 'level' | 'kind' | 'clientTs' | 'appVersion'>): void {
    if (!this.config.includeDebug && level === 'debug') return;
    const evt: LogEvent = {
      sessionId: this.session,
      level,
      kind,
      clientTs: Date.now(),
      appVersion: this.config.appVersion,
      ...partial,
    };
    const fingerprint = `${kind}|${evt.action ?? ''}|${evt.target ?? ''}|${evt.errorMsg ?? ''}`;
    if (fingerprint === this.lastFingerprint && evt.clientTs - this.lastAt < this.config.dedupeWindowMs) {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.lastAt = evt.clientTs;
    this.ring.push(evt);
    if (this.ring.length > this.config.bufferLimit) this.ring.shift();
    this.pending.push(evt);
    // Bounded: with no transport, or a server that stays down, this
    // would otherwise grow for as long as the page lives.
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    for (const fn of this.listeners) fn([evt]);
  }

  /**
   * Send the queue in batches the server accepts (COREAPI-04, 2026-11-09).
   * The whole queue used to go in one call: above the server's limit it
   * was refused, queued again and refused again on every flush. A batch
   * the server refuses is now dropped; one that did not get through is
   * queued again, in order, with the ones after it.
   */
  async flush(beacon = false): Promise<void> {
    if (beacon) {
      this.flushOnHide();
      return;
    }
    const transport = this.transport;
    if (!transport || this.pending.length === 0) return;
    const batches = logBatches(
      this.pending.splice(0, this.pending.length),
      this.config.maxBatchEvents,
      this.config.maxBatchBytes,
    );
    for (let i = 0; i < batches.length; i++) {
      try {
        await transport(batches[i]!);
      } catch (err) {
        if (err instanceof BatchRefused) {
          console.warn('[telemetry] batch refused, dropped', err.status);
          continue;
        }
        this.pending.unshift(...batches.slice(i).flat());
        if (this.pending.length > MAX_PENDING) {
          this.pending.splice(0, this.pending.length - MAX_PENDING);
        }
        console.warn('[telemetry] flush failed', err);
        this.keepIfHidden();
        return;
      }
    }
    // Sent while hidden: the stored copy must not send these again (MWD-01).
    this.keepIfHidden();
  }

  private keepIfHidden(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.keep(this.pending);
    }
  }

  /**
   * Review MWD-01 (modern-web-guidance: batch-analytics-events): the page
   * is being hidden or going away. Every batch used to go at once with
   * keepalive; past the browser's ~64 KiB quota the later ones failed, and
   * they had already left the queue. Now the batches that fit go, in
   * order, and the rest stay queued and are kept in storage for the next
   * start in this tab.
   */
  private flushOnHide(): void {
    const transport = this.transport;
    if (transport && this.pending.length > 0) {
      const batches = logBatches(
        this.pending,
        this.config.maxBatchEvents,
        this.config.maxBatchBytes,
      );
      let room = KEEPALIVE_BUDGET_BYTES - this.keepaliveBytes;
      let taken = 0;
      for (const batch of batches) {
        const bytes = batchBytes(batch);
        if (bytes > room) break;
        room -= bytes;
        const raw = this.pending.slice(taken, taken + batch.length);
        taken += batch.length;
        this.keepaliveBytes += bytes;
        transport(batch, { keepalive: true })
          .catch((err: unknown) => {
            // Refused: sending it again gets the same answer. Anything
            // else (still here after all): queue it again.
            if (err instanceof BatchRefused) return;
            this.pending.unshift(...raw);
            if (this.pending.length > MAX_PENDING) {
              this.pending.splice(0, this.pending.length - MAX_PENDING);
            }
            this.keepIfHidden();
          })
          .finally(() => {
            this.keepaliveBytes -= bytes;
          });
      }
      this.pending.splice(0, taken);
    }
    this.keep(this.pending);
  }

  /** Store `events` (the newest that fit) for the next start, or clear the copy. */
  private keep(events: readonly LogEvent[]): void {
    const storage = this.storage;
    if (!storage) return;
    const key = `${this.config.storageKey}.unsent`;
    try {
      if (events.length === 0) {
        storage.removeItem(key);
        return;
      }
      let kept = events;
      let json = JSON.stringify(kept);
      while (kept.length > 1 && json.length > MAX_KEPT_BYTES) {
        kept = kept.slice(Math.ceil(kept.length / 4));
        json = JSON.stringify(kept);
      }
      if (json.length > MAX_KEPT_BYTES) storage.removeItem(key);
      else storage.setItem(key, json);
    } catch {
      /* storage full or blocked: the events stay in memory only */
    }
  }

  /** The events an earlier page in this tab could not send (and clear them). */
  private takeKept(): LogEvent[] {
    const storage = this.storage;
    if (!storage) return [];
    const key = `${this.config.storageKey}.unsent`;
    try {
      const raw = storage.getItem(key);
      storage.removeItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return (parsed as LogEvent[])
        .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string')
        .slice(-MAX_PENDING);
    } catch {
      return [];
    }
  }

  // Convenience helpers -------------------------------------------------
  error(err: unknown, target?: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.log('error', 'error', { target, errorMsg: e.message, errorStack: e.stack });
  }
  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.flush(true);
  }
}

let globalLogger: Logger | null = null;

export function initLogger(config: LoggerConfig): Logger {
  globalLogger = new Logger(config);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) throw new Error('Logger not initialized');
  return globalLogger;
}

export type { Logger };
