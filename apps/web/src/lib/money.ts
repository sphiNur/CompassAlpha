/**
 * DX-PFE-12 (2026-11-01): display code's side of the D1 money rule — each
 * line qty × price rounded half-up to cents, totals added in integer
 * cents (@compass/contracts/money). The web still multiplied and summed
 * floats in a dozen places (`Number(price) * Number(qty)`), so an
 * estimate or a receipt total could be a cent off the server's figure
 * for the same lines. These wrap the contracts helpers for the inputs
 * screens have: strings or numbers, sometimes empty or missing.
 *
 * ESLint (no-restricted-syntax in eslint.config.js) refuses a new
 * `Number(…) * …`; use these instead.
 */
import { centsToMoney, lineCents } from '@compass/contracts/money';

type Amount = string | number | null | undefined;

/** Plain decimal text for a quantity or price, or null when there is none. */
function decimalText(value: Amount): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // toFixed never uses an exponent here; drop the padding zeros.
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  const text = value.trim();
  return text === '' ? null : text;
}

/** qty × unit price in cents, half-up; null when either is missing or not a number. */
export function lineCentsOf(qty: Amount, unitPrice: Amount): bigint | null {
  const q = decimalText(qty);
  const p = decimalText(unitPrice);
  if (q === null || p === null) return null;
  try {
    return lineCents(q, p);
  } catch {
    return null;
  }
}

/** One money line as a number for display (whole cents); null when it cannot be worked out. */
export function moneyLine(qty: Amount, unitPrice: Amount): number | null {
  const cents = lineCentsOf(qty, unitPrice);
  return cents === null ? null : Number(centsToMoney(cents));
}

/**
 * The total of money lines, each rounded to cents first and added in
 * cents. A line that cannot be worked out (no price yet) adds nothing.
 */
export function sumMoneyLines(lines: Iterable<readonly [qty: Amount, unitPrice: Amount]>): number {
  let total = 0n;
  for (const [qty, unitPrice] of lines) total += lineCentsOf(qty, unitPrice) ?? 0n;
  return Number(centsToMoney(total));
}
