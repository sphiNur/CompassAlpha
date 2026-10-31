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

/** R2-ENG-2: the largest amount one money line may reach (qty × price). */
export const MAX_LINE_AMOUNT = '1000000000000';
const MAX_LINE_CENTS = 100_000_000_000_000n;

/** A decimal string as an integer number of `10^-scale` units. */
function toUnits(value: string): { units: bigint; scale: number } {
  const text = value.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) throw new RangeError(`not a decimal: ${value}`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const units = BigInt(`${whole || '0'}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

/** Divide by 10^shift, rounding half away from zero. */
function roundShift(units: bigint, shift: number): bigint {
  if (shift <= 0) return units * 10n ** BigInt(-shift);
  const divisor = 10n ** BigInt(shift);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const rounded = (abs + divisor / 2n) / divisor;
  return negative ? -rounded : rounded;
}

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

/** A JS number as plain decimal text (no exponent), for already-summed figures. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  // 6 decimals is past any money value's float noise; toFixed never uses
  // an exponent below 1e21, far above any amount here.
  return value.toFixed(6);
}
