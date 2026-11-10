/**
 * The form a purchase answer may close (RUNWEB1-01 / -02, 2026-11-09).
 *
 * One `run.purchaseItem` mutation serves the purchase sheet, a row's ✓ and
 * "+ Add item"; one `run.revisePurchase` serves the sheet and "+ Add
 * item" too. Their answers used to close whatever form was open: tap ✓ on
 * one row, open another row's sheet, and the first answer closed that
 * sheet mid-typing, without the unsaved-changes question. An answer now
 * closes a form only when it is for the same run and product.
 */
export function closedFor<D extends { runId: string; skuId: string | null }>(
  draft: D | null,
  sent: { runId: string; skuId: string },
): D | null {
  return draft && draft.runId === sent.runId && draft.skuId === sent.skuId ? null : draft;
}
