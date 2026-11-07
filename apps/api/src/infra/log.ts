import pino from 'pino';
import { env } from '../env';

/**
 * A failed database query's error repeats every parameter in its message
 * ("Failed query: … params: …") and in a `params` field. For attendance
 * that is a face photo's bytes, its 128 face numbers or a punch's
 * coordinates, so they never reach the log (review 2026-11-07).
 */
const PARAMS_TEXT = /\nparams: [\s\S]*?(?=\n {4}at |\ncaused by: |$)/g;
const NOT_LOGGED = '\nparams: [not logged]';

function scrub(value: unknown, seen: Set<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const o = value as Record<string, unknown>;
  if ('params' in o) delete o.params;
  if (typeof o.message === 'string') o.message = o.message.replace(PARAMS_TEXT, NOT_LOGGED);
  if (typeof o.stack === 'string') o.stack = o.stack.replace(PARAMS_TEXT, NOT_LOGGED);
  for (const key of Object.keys(o)) scrub(o[key], seen);
}

/** pino's error serializer, without query parameters. */
export function serializeError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error);
  scrub(out, new Set());
  return out;
}

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  base: { service: 'compass-api', env: env.NODE_ENV },
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.refreshToken'],
  serializers: { err: serializeError },
});

export type Logger = typeof logger;
