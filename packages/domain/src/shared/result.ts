/**
 * Discriminated Result type — used by `decide()` so a caller can choose
 * between throwing or branching without try/catch noise.
 */
import type { DomainError } from './errors';

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: DomainError };
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (error: DomainError): Err => ({ ok: false, error });

export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw r.error;
  return r.value;
}
