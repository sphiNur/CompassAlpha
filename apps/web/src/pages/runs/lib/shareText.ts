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
 * One stall's list, KEPT SPLIT BY STORE.
 *
 * On 2026-07-26 this was changed to merge quantities across stores and
 * drop the store names, reasoning that a market stall owner should not
 * receive our shop roster. The operator reported that as a regression on
 * 2026-07-27 and asked for the split back, so the split is the
 * behaviour:
 *
 *     savza abat
 *
 *     Eden Magic City
 *     Pomidor: 7 kg
 *     Piyoz: 9 kg
 *
 *     Eden Seoul
 *     Piyoz: 5 kg
 *
 * Why the merge was the wrong call, now that the actual workflow is
 * clear: this text is not only a price quote, it is the instruction for
 * how the goods get divided when they arrive. Merging destroyed exactly
 * the information the purchaser needs at the scale — "9 for one shop, 5
 * for the other" — and the message is the artifact they carry into the
 * market. Whatever a vendor learns about our shop names is a smaller
 * cost than bagging the wrong quantities.
 *
 * Matches the on-screen accordion, which has always shown these
 * per-store sections with their own subtotals. The send now says the
 * same thing the screen does.
 *
 * Notes survive per store by construction — nothing merges, so the
 * "chilled" / "room temperature" collision that the merged version had
 * to dedupe around cannot arise.
 */
export function buildSupplierText(group: PreviewSupplierGroup, deps: ShareTextDeps): string {
  const lines = [group.supplierName, ''];
  for (const store of group.stores) {
    lines.push(store.storeName);
    for (const line of store.items) lines.push(formatLineForText(line, deps));
    if (store.legacyNote) {
      lines.push(`${deps.notesLabel}:`, store.legacyNote);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
