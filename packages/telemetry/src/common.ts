export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  sessionId: string;
  level: LogLevel;
  kind: string;
  action?: string;
  target?: string;
  data?: Record<string, unknown>;
  errorMsg?: string;
  errorStack?: string;
  platform?: string;
  appVersion?: string;
  traceId?: string;
  spanId?: string;
  clientTs: number;
}

export interface TransportOptions {
  /**
   * Review MWD-01 (modern-web-guidance: batch-analytics-events): set only
   * for the send while the page is going away. A keepalive body counts
   * against the browser's ~64 KiB per-origin quota until it is answered,
   * so the regular flush does not use it.
   */
  keepalive?: boolean;
}

export type Transport = (events: LogEvent[], options?: TransportOptions) => Promise<void>;

/**
 * Thrown by a transport when the server refused the batch itself (a 4xx
 * other than 429). Sending it again cannot succeed, so the logger drops
 * it instead of queueing it again (COREAPI-04, 2026-11-09).
 */
export class BatchRefused extends Error {
  constructor(readonly status: number) {
    super(`log batch refused (${status})`);
    this.name = 'BatchRefused';
  }
}

/** The longest text the server keeps of each field (system.log). */
const KEPT_CHARS = { errorMsg: 4000, errorStack: 8000, other: 200 } as const;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
/** `{"events":[` + `]}` around the events. */
const BATCH_OVERHEAD_BYTES = 13;

/** The request body of one batch, in bytes (`{"events":[...]}`). */
export const batchBytes = (events: readonly LogEvent[]): number => jsonBytes({ events });

/**
 * An event that would not fit in a batch on its own, cut to what the
 * server keeps of it: no `data`, and its texts at the server's lengths.
 */
function fitEvent(event: LogEvent, maxBytes: number): LogEvent {
  if (jsonBytes(event) + BATCH_OVERHEAD_BYTES <= maxBytes) return event;
  const cut = (text: string | undefined, max: number) => text?.slice(0, max);
  return {
    ...event,
    data: { _truncated: true },
    action: cut(event.action, KEPT_CHARS.other),
    target: cut(event.target, KEPT_CHARS.other),
    errorMsg: cut(event.errorMsg, KEPT_CHARS.errorMsg),
    errorStack: cut(event.errorStack, KEPT_CHARS.errorStack),
  };
}

/**
 * The events in order, as batches of at most `maxEvents` events and
 * `maxBytes` of JSON each (COREAPI-04).
 */
export function logBatches(
  events: readonly LogEvent[],
  maxEvents: number,
  maxBytes: number,
): LogEvent[][] {
  const batches: LogEvent[][] = [];
  let current: LogEvent[] = [];
  let bytes = BATCH_OVERHEAD_BYTES;
  for (const raw of events) {
    const event = fitEvent(raw, maxBytes);
    const size = jsonBytes(event) + 1; // and its comma
    if (current.length > 0 && (current.length >= maxEvents || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = BATCH_OVERHEAD_BYTES;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const ALPHABET = '0123456789abcdef';
export function shortId(len = 16): string {
  let out = '';
  const buf = new Uint8Array(len);
  if (typeof crypto !== 'undefined') crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i]! % 16];
  return out;
}

export function sessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return shortId(36);
}
