/**
 * Count mode (D1, 2026-11-13): the pure part of counting a whole store
 * on one screen. Each product row takes the quantity found on the shelf;
 * a row left empty is not counted. One save records every count typed,
 * after a summary ("12 products counted, 3 differ from stock").
 *
 * The draft holds, per product, what the number field hands its parent:
 * the normalised number ("1,5" → "1.5"), or the text as typed when it is
 * not one number, which stocktakeCountProblem calls notNumber.
 */
import { stocktakeCountProblem, type StocktakeCountProblem } from '@compass/contracts/limits';
import { qtyMilli, qtyMilliOrZero } from '@compass/contracts/quantity';
import { hasStorePermission } from '../../../lib/storePermission';

/** The counts typed so far, by product id. */
export type CountDraft = Readonly<Record<string, string>>;

/** One count ready to send: what inventory.stocktake takes for a product. */
export interface CountEntry {
  skuId: string;
  target: string;
}

/**
 * The products a count lists: every active product of the organisation,
 * and an archived one that still has stock here (its count can bring it
 * to 0). Each with its on-hand here, '0' when it has no ledger row yet.
 * Input order is preserved.
 */
export function countableProducts<T extends { id: string; isArchived?: boolean }>(
  skus: ReadonlyArray<T>,
  levels: ReadonlyArray<{ skuId: string; onHand: string }>,
): Array<T & { onHand: string }> {
  const onHand = new Map(levels.map((l) => [l.skuId, l.onHand]));
  return skus
    .filter((sku) => !sku.isArchived || qtyMilliOrZero(onHand.get(sku.id)) !== 0n)
    .map((sku) => ({ ...sku, onHand: onHand.get(sku.id) ?? '0' }));
}

/** The rows that were typed into, in the order they were first typed. */
export function typedRows(draft: CountDraft): string[] {
  return Object.keys(draft).filter((skuId) => (draft[skuId] ?? '').trim() !== '');
}

/** Why a typed row cannot be saved, or null when it can (or is empty). */
export function rowProblem(draft: CountDraft, skuId: string): StocktakeCountProblem | null {
  const text = (draft[skuId] ?? '').trim();
  if (text === '') return null;
  return stocktakeCountProblem(text);
}

/** Every typed row, as the batch takes it; rows that do not read are left out. */
export function countsToSave(draft: CountDraft): CountEntry[] {
  return typedRows(draft)
    .filter((skuId) => rowProblem(draft, skuId) === null)
    .map((skuId) => ({ skuId, target: draft[skuId]!.trim() }));
}

export interface CountSummary {
  /** Rows typed into. */
  counted: number;
  /** Of those, counts that read and are not what the system has. */
  differ: number;
  /** Typed rows that cannot be saved as they are. */
  invalid: number;
}

/**
 * What a save would record. A count differs when it is not, to the
 * thousandth, the on-hand the screen showed; compared in thousandths, as
 * the server compares it.
 */
export function countSummary(
  draft: CountDraft,
  onHand: (skuId: string) => string | undefined,
): CountSummary {
  let counted = 0;
  let differ = 0;
  let invalid = 0;
  for (const skuId of typedRows(draft)) {
    counted += 1;
    if (rowProblem(draft, skuId) !== null) {
      invalid += 1;
      continue;
    }
    if (qtyMilli(draft[skuId]!.trim()) !== qtyMilliOrZero(onHand(skuId))) differ += 1;
  }
  return { counted, differ, invalid };
}

/** The draft without the rows a save recorded (a part of a long count). */
export function withoutSaved(draft: CountDraft, saved: ReadonlyArray<string>): CountDraft {
  const done = new Set(saved);
  return Object.fromEntries(Object.entries(draft).filter(([skuId]) => !done.has(skuId)));
}

/** `items` in parts of at most `size` (the batch's limit). */
export function inParts<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

/**
 * The one store `session` may count stock in (inventory.adjust there,
 * store overrides included), or null when there are none or several:
 * the Admin home offers "Count stock" straight away only for one.
 */
export function soleCountStore<S extends { id: string; name: string }>(
  session: Parameters<typeof hasStorePermission>[0] & { stores: ReadonlyArray<S> },
): S | null {
  const stores = session.stores.filter((st) =>
    hasStorePermission(session, st.id, 'inventory.adjust'),
  );
  return stores.length === 1 ? stores[0]! : null;
}
