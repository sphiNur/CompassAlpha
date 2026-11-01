/**
 * DX-CAT-2 (2026-11-01): the line under an activity event that says what
 * it is about — "Tomato 2 · Store 1 · order of 1 Nov" — from the context
 * the server now resolves (admin.recentEvents `context`). The row used to
 * end in "seq 15", a developer's event number.
 *
 * Pure: the caller passes the localizers, so this is unit-testable.
 */
export interface ActivityContextLike {
  storeName: string | null;
  orderDate: string | null;
  runDate: string | null;
  runIndex: number | null;
  skuNames: Record<string, string> | null;
  qty: string | null;
}

export function activityDetail(
  context: ActivityContextLike | null | undefined,
  fmt: {
    productName: (names: Record<string, string>) => string;
    qty: (v: string) => string;
    day: (isoDate: string) => string;
    orderOf: (date: string) => string;
    runLabel: (date: string, n: number) => string;
  },
): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.skuNames) {
    const name = fmt.productName(context.skuNames);
    parts.push(context.qty ? `${name} ${fmt.qty(context.qty)}` : name);
  }
  if (context.storeName) parts.push(context.storeName);
  if (context.orderDate) parts.push(fmt.orderOf(fmt.day(context.orderDate)));
  if (context.runDate && context.runIndex !== null) {
    parts.push(fmt.runLabel(fmt.day(context.runDate), context.runIndex + 1));
  }
  return parts.filter(Boolean).join(' · ');
}
