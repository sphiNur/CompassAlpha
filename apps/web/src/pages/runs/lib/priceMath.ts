/**
 * Thousands-mode price display math (M3.36, 2026-05-19).
 *
 * UZS prices typically run 20–150k; typing the trailing "000" on every
 * row was the operator's #1 friction complaint mid-purchase. In
 * thousands mode the stored / network-sent value stays raw UZS and only
 * the visible string is divided/multiplied at the input boundary.
 *
 * Extracted verbatim from RunPage.tsx (Phase 4 step 1 —
 * FRONTEND_AUDIT_2026-07.md run-domain split). Pure functions; unit
 * tests in __tests__/priceMath.test.ts.
 */

/**
 * Convert a raw UZS price string to its thousands-mode display form.
 * "147500" → "147.5" when in thousands mode; pass-through otherwise.
 * Returns the input unchanged on empty / NaN so intermediate typing
 * states ("147.") don't get clobbered.
 *
 * The `.toFixed(3)` clamp keeps results within the contract's
 * `^\d+(\.\d{1,3})?$` regex — without it, float drift (e.g.
 * 147.555 × 1000 = 147555.00000000003) would let the server reject
 * otherwise-valid inputs.
 */
export function toDisplayPrice(rawStr: string, inThousands: boolean): string {
  if (!inThousands || !rawStr) return rawStr;
  const n = Number(rawStr);
  if (!Number.isFinite(n)) return rawStr;
  return String(Number((n / 1000).toFixed(3)));
}

/** Inverse of toDisplayPrice — used when committing back to the
 *  domain (purchaseItem / revisePurchase always speak raw UZS).
 *  The .toFixed(3) avoids the float-drift "147.555 * 1000 =
 *  147555.00000000003" trap that would fail server validation. */
export function fromDisplayPrice(displayStr: string, inThousands: boolean): string {
  if (!inThousands || !displayStr) return displayStr;
  const n = Number(displayStr);
  if (!Number.isFinite(n)) return displayStr;
  return String(Number((n * 1000).toFixed(3)));
}
