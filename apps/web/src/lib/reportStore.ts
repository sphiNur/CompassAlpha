/**
 * CMP-HIS-1 (2026-10-31): which store History and Finance start on.
 *
 * Both used to show every store's money under a top bar that named one
 * store ("Central Kitchen" above a two-store total), so the reader took
 * the sum for that store. They now start on the store picked in the top
 * bar, and on all stores only when "all stores" is picked there (or the
 * picked store is not one the reader may see the report for — the server
 * would refuse it).
 *
 * Kept free of React so it can be unit-tested.
 */
export type StoreContextLike =
  | { kind: 'specific'; storeId: string }
  | { kind: 'all' }
  | { kind: 'none' };

/** '' means all the stores the reader may see. */
export function defaultReportStore(
  context: StoreContextLike,
  readableStores: ReadonlyArray<{ id: string }> | undefined,
): string {
  if (context.kind !== 'specific' || !readableStores) return '';
  return readableStores.some((store) => store.id === context.storeId) ? context.storeId : '';
}
