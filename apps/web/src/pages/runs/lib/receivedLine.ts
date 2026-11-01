/**
 * DX-DLV-01 (2026-11-01): what a store received on a line it reported a
 * problem with, once a correction of the finished run added quantity.
 *
 * History showed "实收 5 / 12 公斤" and, on the next line, "修改时补记
 * +2 公斤": two figures that read as a contradiction (is it 5 or 7?).
 * Under D3 the added quantity counts as received, and stock books it, so
 * the receiving line now says "实收 5 + 补记 2 = 7 / 12 公斤" and the
 * separate correction line for that store is left out.
 *
 * Returns the amendAdded quantity folded into the receiving line, or
 * null when there is none.
 */
export function amendAddedFor(
  corrections: ReadonlyArray<{ kind: string; skuId: string; storeId: string | null; qty?: string }>,
  skuId: string,
  storeId: string,
): string | null {
  const c = corrections.find(
    (x) => x.kind === 'amendAdded' && x.skuId === skuId && x.storeId === storeId,
  );
  return c?.qty && Number(c.qty) > 0 ? c.qty : null;
}

/** received + added, exact to the thousandth (qty columns are numeric(12,3)). */
export function receivedTotal(received: string, added: string): string {
  const milli = (v: string) => Math.round(Number(v) * 1000);
  return String((milli(received) + milli(added)) / 1000);
}
