import type { I18n } from '@compass/i18n';

/**
 * A unit's label. R2-COPY-4 (2026-10-31): the counted units are ICU
 * plural blocks in en / ru (`unit.pair` → "пара / пары / пар"), so a
 * label printed after a quantity passes that quantity and agrees with it
 * («10 пар», "2 packs").
 *
 * Review TEST3-06 (2026-11-10): the quantity is a required argument, and
 * a label with no number next to it is the separate `.uncounted(unit)`.
 * A one-argument call used to be allowed and gave the dictionary form,
 * which read «0 пара» / "2 pack" after a number; a test kept a list of
 * the allowed calls by their source text.
 */
export interface UnitLabel {
  /** The label after a quantity, agreeing with it. */
  (unit: string | null | undefined, qty: string | number | null | undefined): string;
  /**
   * The label where no number stands next to it: unit pickers, "per kg"
   * prices, the "Unit: …" caption. The singular, dictionary form.
   */
  uncounted(unit: string | null | undefined): string;
}

export function unitLabeller(t: I18n['t']): UnitLabel {
  const label = (
    unit: string | null | undefined,
    qty: string | number | null | undefined,
  ): string => {
    if (!unit) return '';
    const canonical = unit.toLowerCase();
    // i18n.t falls back to the key itself when missing; we want to
    // fall back to the original unit string (with original case)
    // so SKU-level lowercase fix doesn't hide non-canonical units.
    const key = ('unit.' + canonical) as Parameters<typeof t>[0];
    const n = qty === null || qty === undefined || qty === '' ? 1 : Number(qty);
    const localized = t(key, { n: Number.isFinite(n) ? n : 1 });
    return localized === key ? unit : localized;
  };
  return Object.assign(label, {
    uncounted: (unit: string | null | undefined) => label(unit, undefined),
  });
}
