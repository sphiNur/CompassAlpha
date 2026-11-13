/**
 * UX-25 (2026-11-14): how the daily close shows the day's sales.
 *
 *   none      the member cannot record sales in this store.
 *   noDishes  the workspace has no dish (archived ones count, so a day
 *             with sales of a dish archived since keeps its list): one
 *             line saying so, below Revenue. The whole block (two
 *             headings, a 0 / 0 card, "no dishes") filled the first
 *             screen at 360 px and pushed Revenue to ~645 of 844 px.
 *   full      the sales panel in its disclosure, as before. Also while
 *             the dishes load or cannot be read: the panel says why.
 */
export type SalesBlock = 'none' | 'noDishes' | 'full';

export function salesBlockLayout({
  canRecordSales,
  dishCount,
}: {
  canRecordSales: boolean;
  /** Undefined while unknown (loading, failed, offline with no copy). */
  dishCount: number | undefined;
}): SalesBlock {
  if (!canRecordSales) return 'none';
  return dishCount === 0 ? 'noDishes' : 'full';
}
