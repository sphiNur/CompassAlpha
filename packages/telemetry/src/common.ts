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

export type Transport = (events: LogEvent[]) => Promise<void>;

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
