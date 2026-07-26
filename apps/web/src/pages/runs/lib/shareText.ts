/**
 * Share-text builders for the pre-run preview card.
 *
 * These produce the strings the purchaser pastes into a Telegram chat:
 * one flavour aimed at OUR store managers, one aimed at an OUTSIDE
 * market stall owner. Keeping them apart is a disclosure boundary, not
 * a formatting preference — see `buildSupplierText`.
 *
 * Extracted out of RunPanels.tsx (2026-07-26). They were closures over
 * the component's i18n/catalog state, which meant the only way to check
 * what actually lands in a vendor's chat was to eyeball the running app.
 * That is how the M3.45/M3.48 vendor-language feature got silently
 * reverted by a layout refactor with no test failing. Pure functions +
 * `__tests__/shareText.test.ts` close that hole; the web app has no DOM
 * test environment, so pure-function extraction is the only testable
 * shape available.
 */
import { formatQty } from '../../../lib/format';
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../types';

export type ShareTextDeps = {
  /**
   * Localized display name + localized unit label for a catalog SKU, or
   * null when the id isn't in the catalog map — in which case the line's
   * own `name` / `unit` are used verbatim (that is the "extra" path).
   */
  resolveSku: (skuId: string) => { name: string; unit: string } | null;
  /** i18n.t('order.extras.label') */
  extrasLabel: string;
  /** i18n.t('order.notes.label') */
  notesLabel: string;
};

/** Localized `{name, unit}` for a line, falling back to the line's own. */
function displayOf(line: PreviewLine, deps: ShareTextDeps): { name: string; unit: string } {
  const sku = line.skuId ? deps.resolveSku(line.skuId) : null;
  return sku ?? { name: line.name, unit: line.unit };
}

/**
 * One line of STORE-facing text: `[其他物品 · ]Name: 2 kg[\n  note]`.
 * Store managers get the extras marker because "off-catalog" is a
 * meaningful distinction on their side of the transaction.
 */
export function formatLineForText(line: PreviewLine, deps: ShareTextDeps): string {
  const { name, unit } = displayOf(line, deps);
  const qtyUnit = `${formatQty(line.qty)} ${unit}`.trim();
  const prefix = line.kind === 'extra' ? `${deps.extrasLabel} · ` : '';
  const note = line.note ? `\n  ${line.note}` : '';
  return `${prefix}${name}: ${qtyUnit}${note}`;
}

/**
 * Store-facing list. Carries the store's own name as the header — this
 * string only ever goes to that store's manager.
 */
export function buildStoreText(group: PreviewStoreGroup, deps: ShareTextDeps): string {
  const lines = [group.storeName, ''];
  for (const line of group.items) lines.push(formatLineForText(line, deps));
  if (group.legacyNote) {
    lines.push('', `${deps.notesLabel}:`, group.legacyNote);
  }
  return lines.join('\n').trim();
}

/**
 * Vendor-facing list. Two deliberate differences from
 * `buildStoreText`, both of which were bugs before 2026-07-26:
 *
 *   1. NO store names. This string is pasted into a market stall
 *      owner's chat. The previous version pushed every `storeName` as a
 *      section header, so every "send" handed an outside party our full
 *      shop roster plus which shop wants what.
 *   2. Quantities MERGED across stores. The vendor sells one pile —
 *      "tomatoes 11 kg", not three lines of 5 / 3 / 3 for them to add up
 *      at the scale.
 *
 * Also drops the extras marker: "off-catalog" is internal vocabulary the
 * vendor has no context for. A tomato is a tomato.
 *
 * Merging is quantity-only: EVERY distinct note survives. Dropping all
 * but the first was a real bug in the first cut of this function — two
 * stores asking for the same off-catalog item with conflicting
 * requirements ("chilled" vs "room temperature") collapsed to one line
 * carrying only the first, and the copied text was the only artifact
 * the purchaser carried into the market.
 */
export function buildSupplierText(group: PreviewSupplierGroup, deps: ShareTextDeps): string {
  const merged = new Map<string, { name: string; unit: string; qty: number; notes: string[] }>();
  for (const store of group.stores) {
    for (const line of store.items) {
      const { name, unit } = displayOf(line, deps);
      // Extras carry no skuId, so key them on localized name + unit —
      // two stores asking for the same off-catalog item still merge.
      const key = line.skuId ?? `extra:${name}|${unit}`;
      const qty = Number(line.qty);
      const safeQty = Number.isFinite(qty) ? qty : 0;
      const cur = merged.get(key);
      if (cur) {
        cur.qty += safeQty;
        // Dedupe identical notes (the common case: both stores typed
        // the same thing) but keep genuinely different ones.
        if (line.note && !cur.notes.includes(line.note)) cur.notes.push(line.note);
      } else {
        merged.set(key, {
          name,
          unit,
          qty: safeQty,
          notes: line.note ? [line.note] : [],
        });
      }
    }
  }

  const lines = [group.supplierName, ''];
  for (const item of merged.values()) {
    // formatQty rounds to 1 decimal, which also absorbs the float drift
    // from summing splits (0.1 + 0.2 reads as 0.3, not 0.30000000000000004).
    const qtyUnit = `${formatQty(item.qty)} ${item.unit}`.trim();
    const notes = item.notes.map((n) => `\n  ${n}`).join('');
    lines.push(`${item.name}: ${qtyUnit}${notes}`);
  }

  // legacyNote only ever lands on the "unassigned supplier" bucket (see
  // the bySupplier memo in RunPanels), so a real vendor never sees these
  // — but `sendAll` concatenates that bucket too. Keep the text, drop
  // the store attribution.
  const notes = group.stores.map((s) => s.legacyNote).filter((n): n is string => Boolean(n));
  if (notes.length > 0) {
    lines.push('', `${deps.notesLabel}:`, ...notes);
  }

  return lines.join('\n').trim();
}
