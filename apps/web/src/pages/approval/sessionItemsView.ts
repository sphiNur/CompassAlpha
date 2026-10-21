/**
 * 2026-10-21 FE-02 (F2-01): what the approval detail of one session
 * shows. An order may carry only off-catalog extras (or legacy notes)
 * and no SKU lines; the "empty" state must then cover the SKU section
 * only, never hide the extras the manager is asked to approve.
 */
export interface SessionItemsInput {
  totals: ReadonlyArray<{ qty: string | number }>;
  extras: ReadonlyArray<unknown> | null | undefined;
  notes: string | null | undefined;
}

export interface SessionItemsView {
  /** Nothing at all to show: render one overall empty state. */
  allEmpty: boolean;
  showExtras: boolean;
  showNotes: boolean;
  /** SKU lines with qty > 0 exist. */
  hasSkus: boolean;
  /** SKU section is empty while extras/notes exist: show its own empty line. */
  skuSectionEmpty: boolean;
}

export function sessionItemsView(input: SessionItemsInput): SessionItemsView {
  const hasSkus = input.totals.some((t) => Number(t.qty) > 0);
  const showExtras = (input.extras?.length ?? 0) > 0;
  const showNotes = !!input.notes && input.notes.trim().length > 0;
  const allEmpty = !hasSkus && !showExtras && !showNotes;
  return {
    allEmpty,
    showExtras,
    showNotes,
    hasSkus,
    skuSectionEmpty: !hasSkus && !allEmpty,
  };
}
