/**
 * Quantities as exact decimals (review RUNAPI-05, 2026-11-09).
 *
 * A quantity has at most 3 decimals (`PurchaseQtySchema`; numeric(12,3) in
 * the read models). Added as JS numbers, two orders of 0.1 and 0.2 kg made
 * "0.30000000000000004", and that string went into RunPlanned's payload,
 * which is kept for ever, and into the run state. Here a quantity is a
 * whole number of thousandths (BigInt). Results print the way
 * `String(Number(q))` prints a clean value: no exponent, no trailing
 * zeros, "0" for zero ("1.5", "0.333", "2").
 */
import { numberText, roundShift, toUnits } from './decimal';

/** A quantity in thousandths; past 3 decimals it rounds half away from zero. */
export function qtyMilli(value: string | number): bigint {
  const text = typeof value === 'number' ? numberText(value) : value;
  const { units, scale } = toUnits(text);
  return roundShift(units, scale - 3);
}

/** Thousandths as a quantity string: "1.5", "0.333", "2", "-0.1". */
export function milliQty(milli: bigint): string {
  const negative = milli < 0n;
  const digits = (negative ? -milli : milli).toString().padStart(4, '0');
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}${fraction ? `.${fraction}` : ''}`;
}

/** A quantity in that form, rounded to 3 decimals ("0.30000000000000004" → "0.3"). */
export function normalizeQty(value: string | number): string {
  return milliQty(qtyMilli(value));
}

/** a + b, exactly. */
export function addQty(a: string | number, b: string | number): string {
  return milliQty(qtyMilli(a) + qtyMilli(b));
}

/** a − b, exactly. */
export function subQty(a: string | number, b: string | number): string {
  return milliQty(qtyMilli(a) - qtyMilli(b));
}

/** The sum of quantities; null, undefined and '' add nothing. */
export function sumQty(values: Iterable<string | number | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    total += qtyMilli(value);
  }
  return milliQty(total);
}

/**
 * a × b, rounded once to 3 decimals, half away from zero: a recipe's amount
 * per serving times the servings sold (review CONF-15). Multiplying floats
 * and calling toFixed(3) rounded some halves down, unlike every other
 * quantity here: 1.0005 × 1 gave "1.000" and 0.0045 × 1 gave "0.004".
 */
export function mulQty(a: string | number, b: string | number): string {
  const x = toUnits(typeof a === 'number' ? numberText(a) : a);
  const y = toUnits(typeof b === 'number' ? numberText(b) : b);
  return milliQty(roundShift(x.units * y.units, x.scale + y.scale - 3));
}
