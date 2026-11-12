import type { PaymentMethod } from '@compass/contracts';

/**
 * A stored method as one of the two. Rows from before the method was
 * recorded (M1.14) have none and count as cash, as the server reads them.
 *
 * Review RUNWEB2-15 (2026-11-12): the run page's price overrides, its
 * top-up, the purchase editor and the expense templates each had their
 * own copy of this.
 */
export function paymentMethodOrCash(value: string | null | undefined): PaymentMethod {
  return value === 'transfer' ? 'transfer' : 'cash';
}
