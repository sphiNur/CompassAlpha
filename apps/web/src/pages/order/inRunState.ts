/**
 * DX-DLV-13 (2026-11-01): what the order page says about an order that is
 * on a purchase run. It read 「采购中 · 正在购买」 from the moment the run
 * started until it finished — also while the goods stood at the door
 * waiting to be checked.
 */
export type InRunState = 'buying' | 'onTheWay' | 'recalled' | 'toCheck' | 'checked';

export function inRunState(
  run:
    | {
        status: string;
        splits: ReadonlyArray<{ storeId: string; deliveredAt: unknown; confirmedAt: unknown }>;
        recalledStoreIds?: readonly string[];
      }
    | undefined,
  storeId: string,
): InRunState {
  if (!run || run.status !== 'delivering') return 'buying';
  const mine = run.splits.filter((sp) => sp.storeId === storeId);
  if ((run.recalledStoreIds ?? []).includes(storeId)) return 'recalled';
  const delivered = mine.filter((sp) => !!sp.deliveredAt);
  if (delivered.length === 0) return 'onTheWay';
  return delivered.every((sp) => !!sp.confirmedAt) ? 'checked' : 'toCheck';
}
