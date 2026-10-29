import { SKU_STEPS, type SkuStep } from '@compass/contracts';

/**
 * Snap a legacy step value onto the canonical grid.
 *
 * Exact matches pass through; anything else collapses to the M3.14
 * rule (<= 0.5 → '0.5', else '1') — never up-snap a stale 5 or 25 to
 * a bulk step the operator didn't choose.
 */
export function snapStepToCanonical(step: string): SkuStep {
  if ((SKU_STEPS as readonly string[]).includes(step)) return step as SkuStep;
  const n = Number(step);
  if (!Number.isFinite(n)) return '1';
  // The column is numeric(…,3): a 10-pack comes back as '10.000', which is
  // not the string '10'. Compare by value, or every edit saved step 1.
  const exact = SKU_STEPS.find((canonical) => Number(canonical) === n);
  if (exact) return exact;
  return n <= 0.5 ? '0.5' : '1';
}
