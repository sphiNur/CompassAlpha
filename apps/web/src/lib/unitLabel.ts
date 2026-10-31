import type { I18n } from '@compass/i18n';

/**
 * `(unit, qty?) => label`. R2-COPY-4 (2026-10-31): the counted units are
 * ICU plural blocks in en / ru (`unit.pair` → "пара / пары / пар"), so a
 * label printed after a quantity passes that quantity and agrees with it
 * («10 пар», "2 packs"). Without one the label is the singular form the
 * unit pickers and "单位：…" lines show.
 */
export function unitLabeller(t: I18n['t']) {
  return (unit: string | null | undefined, qty?: string | number | null): string => {
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
}
