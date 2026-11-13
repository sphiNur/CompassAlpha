import { formatAmountInFull } from '../lib/format';
import { useCurrency } from './useCurrency';

/**
 * UX-08 (2026-11-14): the grouped preview of a full-amount field
 * ("830,000 UZS"), given to its Field as the `hint`, so it sits under the
 * field and is read with it. Null (no line) while the field is empty or
 * invalid. Not for the Run page's thousands mode, which has PriceInFull.
 */
export function useAmountInFull(value: string): string | null {
  const currency = useCurrency();
  return formatAmountInFull(value, currency);
}
