/**
 * Browser logger.
 *
 * Strategy:
 *   - Ring buffer (200 events) for the live `/debug` view.
 *   - In-memory queue (capped) handed to the transport the app sets.
 *   - 5 s flush interval + flush on `pagehide`/`online`/`visibilitychange`.
 *   - Dedupe identical events fired within 200 ms.
 */
import type { LogEvent, LogLevel, Transport } from './common';
import { BatchRefused, logBatches, sessionId as makeSessionId } from './common';

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
}

const DEFAULTS = {
  flushIntervalMs: 5_000,
  bufferLimit: 200,
  dedupeWindowMs: 200,
  storageKey: 'compass.session',
  includeDebug: true,
};

const MAX_PENDING = 500;

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

  constructor(config: LoggerConfig) {
    this.config = { ...DEFAULTS, ...config } as Required<LoggerConfig>;
    this.session =
      (typeof window !== 'undefined' &&
        window.sessionStorage?.getItem(this.config.storageKey)) ||
      makeSessionId();
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem(this.config.storageKey, this.session);
      // flush() catches its own failures (it requeues or drops the batch).
      window.addEventListener('pagehide', () => void this.flush(true));
      window.addEventListener('online', () => void this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush(true);
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
    const transport = this.transport;
    if (!transport || this.pending.length === 0) return;
    const batches = logBatches(
      this.pending.splice(0, this.pending.length),
      this.config.maxBatchEvents,
      this.config.maxBatchBytes,
    );
    if (beacon) {
      // The page is going away: send everything at once, nothing to queue.
      for (const batch of batches) void transport(batch).catch(() => undefined);
      return;
    }
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
        return;
      }
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
