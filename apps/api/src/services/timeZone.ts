import { isTimeZone } from '@compass/contracts';

/**
 * The time zone a store's business day runs in: its own when it is a real
 * zone, else the organisation's. CLS-7 (2026-10-30): a store saved with an
 * unknown zone made every business-date read for it fail (no daily close,
 * no sales list); input is validated now, and rows saved before still work.
 */
export function storeTimeZone(storeZone: string | null | undefined, orgZone: string): string {
  return storeZone && isTimeZone(storeZone) ? storeZone : orgZone;
}
