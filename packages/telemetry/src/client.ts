/**
 * Browser logger.
 *
 * Strategy:
 *   - Ring buffer (200 events) for the live `/debug` view.
 *   - IDB queue for durable batching across reloads/network drops.
 *   - 5 s flush interval + flush on `pagehide`/`online`/`visibilitychange`.
 *   - Dedupe identical events fired within 200 ms.
 */
import type { LogEvent, LogLevel, Transport } from './common';
import { sessionId as makeSessionId } from './common';

interface LoggerConfig {
  appVersion: string;
  flushIntervalMs?: number;
  bufferLimit?: number;
  dedupeWindowMs?: number;
  storageKey?: string;
  /** When false the logger drops debug-level events to keep prod traffic low. */
  includeDebug?: boolean;
}

const DEFAULTS = {
  flushIntervalMs: 5_000,
  bufferLimit: 200,
  dedupeWindowMs: 200,
  storageKey: 'compass.session',
  includeDebug: true,
};

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
      window.addEventListener('pagehide', () => this.flush(true));
      window.addEventListener('online', () => this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush(true);
      });
    }
    this.timer = setInterval(() => this.flush(), this.config.flushIntervalMs);
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
    for (const fn of this.listeners) fn([evt]);
  }

  async flush(beacon = false): Promise<void> {
    if (!this.transport || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.transport(batch);
    } catch (err) {
      // Re-queue on failure unless we're in beacon mode (page unloading).
      if (!beacon) this.pending.unshift(...batch);
      // eslint-disable-next-line no-console
      console.warn('[telemetry] flush failed', err);
    }
  }

  // Convenience helpers -------------------------------------------------
  click(label: string, target?: string, data?: Record<string, unknown>): void {
    this.log('debug', 'click', { action: label, target, data });
  }
  nav(from: string, to: string): void {
    this.log('debug', 'nav', { action: 'route', target: to, data: { from } });
  }
  rpcRequest(name: string, traceId?: string): void {
    this.log('debug', 'rpc.request', { action: name, traceId });
  }
  rpcResponse(name: string, ms: number, traceId?: string): void {
    this.log('debug', 'rpc.response', { action: name, traceId, data: { ms } });
  }
  rpcError(name: string, err: { message?: string; code?: string }, traceId?: string): void {
    this.log('warn', 'rpc.error', {
      action: name,
      traceId,
      errorMsg: err.message ?? 'unknown',
      data: { code: err.code },
    });
  }
  error(err: unknown, target?: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.log('error', 'error', { target, errorMsg: e.message, errorStack: e.stack });
  }
  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(true);
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
