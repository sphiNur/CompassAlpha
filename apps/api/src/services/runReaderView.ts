/**
 * What a reader limited to some stores is sent of a run (review
 * RUNAPI-14). run.get and run.historyDetail each carried their own copy
 * of these rules; the expense one had already drifted (RUNAPI-11).
 *
 * Such a reader sees only their stores' splits, with what a split
 * inherits from its item (price, payment method) filled in, so reading
 * them never needs an organisation-wide value. An item's quantities
 * become the reader's own; its price and payment method show only when
 * every visible split agrees; its supplier and receipt, which belong to
 * no one store, are withheld when a store the reader cannot see shares
 * the item.
 */
import { sumQty } from '@compass/contracts/quantity';
import type { schema } from '@compass/db';

type RunItemRow = {
  skuId: string;
  status: string;
  plannedQty: string;
  purchasedQty: string | null;
  unitPrice: string | null;
  paymentMethod: string | null;
  supplierId: string | null;
  receiptPhotoUrl: string | null;
};

type RunSplitRow = {
  skuId: string;
  storeId: string;
  qty: string;
  unitPrice: string | null;
  paymentMethod: string | null;
};

/**
 * The splits of the reader's stores (all of them when `visibleStoreIds`
 * is null), and the products of which a split was left out.
 */
export function splitsForReader<S extends RunSplitRow>(
  items: readonly RunItemRow[],
  splits: readonly S[],
  visibleStoreIds: ReadonlySet<string> | null,
): { splits: S[]; hiddenSkuIds: Set<string> } {
  if (visibleStoreIds === null) return { splits: [...splits], hiddenSkuIds: new Set() };
  const itemBySku = new Map(items.map((item) => [item.skuId, item]));
  const hiddenSkuIds = new Set(
    splits.filter((split) => !visibleStoreIds.has(split.storeId)).map((split) => split.skuId),
  );
  const visible = splits
    .filter((split) => visibleStoreIds.has(split.storeId))
    .map((split) => {
      const item = itemBySku.get(split.skuId);
      return {
        ...split,
        unitPrice: split.unitPrice ?? item?.unitPrice ?? null,
        paymentMethod: split.paymentMethod ?? item?.paymentMethod ?? null,
      };
    });
  return { splits: visible, hiddenSkuIds };
}

/**
 * The run's items as a reader limited to some stores sees them, from the
 * splits `splitsForReader` returned and what those stores' sessions asked
 * for. An item the reader's stores neither asked for nor received is left
 * out.
 */
export function itemsForStoreReader<T extends RunItemRow>(
  items: readonly T[],
  splits: readonly RunSplitRow[],
  demand: readonly { skuId: string; qty: string }[],
  hiddenSkuIds: ReadonlySet<string>,
): Array<Omit<T, 'paymentMethod'> & { paymentMethod: string | null }> {
  const splitsBySku = groupBySku(splits);
  const demandBySku = groupBySku(demand);
  return items
    .filter((item) => (item.status === 'purchased' ? splitsBySku : demandBySku).has(item.skuId))
    .map((item) => {
      const itemSplits = splitsBySku.get(item.skuId) ?? [];
      const bought = sumQty(itemSplits.map((split) => split.qty));
      const asked = sumQty((demandBySku.get(item.skuId) ?? []).map((line) => line.qty));
      const purchased = item.status === 'purchased';
      const shared = hiddenSkuIds.has(item.skuId);
      return {
        ...item,
        plannedQty: asked !== '0' ? asked : bought,
        purchasedQty: purchased ? bought : item.purchasedQty,
        unitPrice: purchased ? sameForAll(itemSplits.map((split) => split.unitPrice)) : null,
        paymentMethod: purchased
          ? sameForAll(itemSplits.map((split) => split.paymentMethod))
          : null,
        supplierId: shared ? null : item.supplierId,
        receiptPhotoUrl: shared ? null : item.receiptPhotoUrl,
      };
    });
}

/**
 * A run's active expenses as a reader sees them: only the splits of the
 * reader's stores, the quantity summed over those, and no receipt photo
 * when a split was cut off. The photo shows the whole amount, and with it
 * the other stores' shares. Review RUNAPI-11 (2026-11-09): run.get had
 * this rule and historyDetail returned the photo; both use this now.
 */
export function expensesForReader(
  rawExpenses: ReadonlyArray<typeof schema.runExpensesV.$inferSelect>,
  allowedStoreSet: ReadonlySet<string> | null,
) {
  return rawExpenses.flatMap((expense) => {
    const allStoreSplits = expense.storeSplitsJson as Array<{ storeId: string; qty: string }>;
    const storeSplits = allowedStoreSet
      ? allStoreSplits.filter((split) => allowedStoreSet.has(split.storeId))
      : allStoreSplits;
    if (storeSplits.length === 0) return [];
    return [
      {
        id: expense.id,
        label: expense.label,
        unitHint: expense.unitHint,
        qty: sumQty(storeSplits.map((split) => split.qty)),
        unitPrice: expense.unitPrice,
        storeSplits,
        paymentMethod: expense.paymentMethod,
        receiptPhotoUrl:
          storeSplits.length !== allStoreSplits.length ? null : expense.receiptPhotoUrl,
        reason: expense.reason,
        addedByMemberId: expense.addedByMemberId,
        addedAt: expense.addedAt.toISOString(),
      },
    ];
  });
}

/** The value every entry has; null when they differ, one is null, or there are none. */
function sameForAll(values: readonly (string | null)[]): string | null {
  const first = values[0] ?? null;
  return first !== null && values.every((value) => value === first) ? first : null;
}

function groupBySku<R extends { skuId: string }>(rows: readonly R[]): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const list = out.get(row.skuId);
    if (list) list.push(row);
    else out.set(row.skuId, [row]);
  }
  return out;
}
