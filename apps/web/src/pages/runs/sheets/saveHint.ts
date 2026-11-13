/**
 * UX-05 (2026-11-13): the line over a purchase / add-item sheet's disabled
 * Save, naming what it waits for. The rules are the sheets' own
 * (lib/purchaseForm.ts); this only puts them in words.
 */
import type { I18n } from '@compass/i18n';

type T = I18n['t'];

/** The quantity bought is empty or not above 0. */
export function qtyHint(t: T, qty: string): string {
  return qty.trim()
    ? t('common.errors.positiveDecimal')
    : t('common.hint.fillIn', { field: t('run.action.actualQtyPlain') });
}

/** The unit price is empty or not one the server takes. */
export function priceHint(t: T, price: string, currency: string): string {
  return price.trim()
    ? t('run.errors.priceFormat')
    : t('common.hint.fillIn', { field: t('run.action.unitPriceUzs', { currency }) });
}
