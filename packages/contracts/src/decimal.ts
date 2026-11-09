/**
 * Exact decimal arithmetic on strings, shared by the money rule (money.ts)
 * and quantities (quantity.ts). Not exported from the package: callers use
 * those two modules.
 */

/** A decimal string as an integer number of `10^-scale` units. */
export function toUnits(value: string): { units: bigint; scale: number } {
  const text = value.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) throw new RangeError(`not a decimal: ${value}`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const units = BigInt(`${whole || '0'}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

/** Divide by 10^shift, rounding half away from zero. */
export function roundShift(units: bigint, shift: number): bigint {
  if (shift <= 0) return units * 10n ** BigInt(-shift);
  const divisor = 10n ** BigInt(shift);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const rounded = (abs + divisor / 2n) / divisor;
  return negative ? -rounded : rounded;
}

/** A JS number as plain decimal text (no exponent), for already-summed figures. */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  // 6 decimals is past the float noise of any money (2 decimals) or
  // quantity (3) value; toFixed never uses an exponent below 1e21, far
  // above any amount here.
  return value.toFixed(6);
}
