/**
 * The payment method the purchaser last chose in a run, kept on this
 * device, so the one-tap ✓ records it instead of always cash
 * (simplification R10, 2026-11-13). One run at a time: a method kept
 * for another run reads as cash, the documented default.
 */
import type { PaymentMethod } from '@compass/contracts';
import { readLocalPref, writeLocalPref } from '../../../lib/localPref';
import { paymentMethodOrCash } from '../../../lib/paymentMethod';

const KEY = 'compass.run.lastPaymentMethod';

/** The method last chosen in `runId`, or cash. */
export function lastPaymentMethod(runId: string): PaymentMethod {
  const saved = readLocalPref(KEY);
  if (!saved) return 'cash';
  const at = saved.lastIndexOf(':');
  return saved.slice(0, at) === runId ? paymentMethodOrCash(saved.slice(at + 1)) : 'cash';
}

/** Keeps `method` as the one last chosen in `runId`. */
export function rememberPaymentMethod(runId: string, method: PaymentMethod): void {
  writeLocalPref(KEY, `${runId}:${method}`);
}
