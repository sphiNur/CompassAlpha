/**
 * D1 (owner decision, 2026-10-31): how purchase money is rounded.
 *
 * A quantity has 3 decimals and a price 2, so `0.5 × 2.01` is 1.005 — half
 * a cent. Every surface used to round that its own way (SQL numeric summed
 * unrounded, `Number().toFixed(2)` per row, float sums in the domain, a
 * client re-summing already rounded rows), so the same run showed totals
 * one cent apart on one screen (R2-HIS-1, RE-ENG-1, B13).
 *
 * The one rule now:
 *   - a money line is one store's share of a purchase (or of an expense):
 *     qty × unit price, rounded half-up to cents;
 *   - every total is the sum of those lines, in integer cents.
 *
 * The SQL twin is `ROUND(qty * price, 2)` in apps/api services/runMoney.ts
 * (numeric ROUND rounds half away from zero, the same as `lineCents` for
 * the non-negative amounts money lines hold). All arithmetic here is on
 * decimal strings with BigInt — no floats.
 */
import { numberText, roundShift, toUnits } from './decimal';

/** R2-ENG-2: the largest amount one money line may reach (qty × price). */
export const MAX_LINE_AMOUNT = '1000000000000';
const MAX_LINE_CENTS = 100_000_000_000_000n;

/** A decimal string ("12.5", "1005", "0.005") in cents, half-up. */
export function toCents(value: string | number): bigint {
  const text = typeof value === 'number' ? numberText(value) : value;
  const { units, scale } = toUnits(text);
  return roundShift(units, scale - 2);
}

/** One money line: qty × unit price, rounded half-up to cents. */
export function lineCents(qty: string, unitPrice: string): bigint {
  const a = toUnits(qty);
  const b = toUnits(unitPrice);
  return roundShift(a.units * b.units, a.scale + b.scale - 2);
}

/** Cents as a money string with exactly two decimals ("1234.50", "-0.05"). */
export function centsToMoney(cents: bigint): string {
  const negative = cents < 0n;
  const digits = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** One money line as a string: `lineCents` formatted. */
export function lineAmount(qty: string, unitPrice: string): string {
  return centsToMoney(lineCents(qty, unitPrice));
}

/** Sum of money strings, each first taken to cents (half-up). */
export function sumMoney(values: Iterable<string | number | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    total += toCents(value);
  }
  return centsToMoney(total);
}

/**
 * A running total kept as a JS number for display code: `sum + value`
 * taken back to whole cents at every step, so adding already rounded
 * rows never drifts (0.1 + 0.2 stays 0.3). Exact up to ~1e13.
 */
export function addMoney(sum: number, value: string | number | null | undefined): number {
  try {
    return Number(sumMoney([sum, value]));
  } catch {
    // A value that is not a number adds nothing, as `Number(v) || 0` did.
    return sum;
  }
}

/** One money line as a JS number for display code (see addMoney). */
export function lineAmountNumber(qty: string, unitPrice: string): number {
  return Number(lineAmount(qty, unitPrice));
}

/** R2-ENG-2: whether qty × unit price stays within MAX_LINE_AMOUNT. */
export function lineWithinCap(qty: string, unitPrice: string): boolean {
  const cents = lineCents(qty, unitPrice);
  return (cents < 0n ? -cents : cents) <= MAX_LINE_CENTS;
}

/** What an order should cost (see estimateOrder). Money strings have two decimals. */
export interface OrderEstimate {
  total: string;
  cash: string;
  transfer: string;
  /** Lines that had a price, and lines that had none. */
  known: number;
  unknown: number;
}

/**
 * Review ORD-01 (2026-11-09): the one estimate rule. Each product with a
 * quantity is a money line at the price `priceOf` gives (the last price
 * paid), and the lines add up in cents, split by how `methodOf` says the
 * product is usually paid.
 *
 * The server used to multiply and add floats with the unrounded weighted
 * price, and the web followed this rule with the price rounded to cents,
 * so an approval card's "~" and the estimate inside it could be a cent
 * apart. Both now call this. A product without a price counts in
 * `unknown`, so a screen can say the sum is partial.
 */
export function estimateOrder(
  lines: Iterable<{ skuId: string; qty: string }>,
  priceOf: (skuId: string) => string | null | undefined,
  methodOf: (skuId: string) => 'cash' | 'transfer' = () => 'cash',
): OrderEstimate {
  let total = 0n;
  let cash = 0n;
  let transfer = 0n;
  let known = 0;
  let unknown = 0;
  for (const line of lines) {
    if (!(Number(line.qty) > 0)) continue;
    const price = priceOf(line.skuId);
    if (price === null || price === undefined || price === '') {
      unknown += 1;
      continue;
    }
    const cents = lineCents(line.qty, price);
    total += cents;
    known += 1;
    if (methodOf(line.skuId) === 'transfer') transfer += cents;
    else cash += cents;
  }
  return {
    total: centsToMoney(total),
    cash: centsToMoney(cash),
    transfer: centsToMoney(transfer),
    known,
    unknown,
  };
}
