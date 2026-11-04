/**
 * Submitted vs. now (2026-11-05). Review edits overwrite an order's lines;
 * the API returns the order as submitted (`order.submittedVersion`) and
 * this compares it with the lines now, per product (totals across
 * contributors).
 */
export type LineChange =
  | { kind: 'changed'; before: number; after: number }
  | { kind: 'added'; after: number }
  | { kind: 'removed'; before: number };

export function submittedDiff(
  submitted: ReadonlyArray<{ skuId: string; qty: string | number }> | null | undefined,
  now: ReadonlyArray<{ skuId: string; qty: string | number }>,
): Map<string, LineChange> {
  const out = new Map<string, LineChange>();
  if (!submitted) return out;
  const sum = (rows: ReadonlyArray<{ skuId: string; qty: string | number }>) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const q = Number(r.qty);
      if (q > 0) m.set(r.skuId, (m.get(r.skuId) ?? 0) + q);
    }
    return m;
  };
  const before = sum(submitted);
  const after = sum(now);
  for (const [skuId, b] of before) {
    const a = after.get(skuId) ?? 0;
    if (a === 0) out.set(skuId, { kind: 'removed', before: b });
    else if (Math.abs(a - b) > 1e-9) out.set(skuId, { kind: 'changed', before: b, after: a });
  }
  for (const [skuId, a] of after) {
    if (!before.has(skuId)) out.set(skuId, { kind: 'added', after: a });
  }
  return out;
}

/** True when the off-catalog items differ from those submitted. */
export function extrasChanged(
  submitted: ReadonlyArray<{ name: string; qty: string; unit: string }> | null | undefined,
  now: ReadonlyArray<{ name: string; qty: string; unit: string }>,
): boolean {
  if (!submitted) return false;
  const key = (rows: ReadonlyArray<{ name: string; qty: string; unit: string }>) =>
    rows.map((r) => `${r.name.trim()}\u0000${Number(r.qty)}\u0000${r.unit}`).join('\u0001');
  return key(submitted) !== key(now);
}
