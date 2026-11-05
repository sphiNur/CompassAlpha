/**
 * Walkthrough F28 (2026-11-05): "2 项修改等待联网发送" after tapping + twice
 * on one product. The outbox holds one write per tap, but the person
 * changed one thing. Writes aimed at the same target (procedure + product
 * / session / store / run / expense) count once; a write with none of
 * those counts on its own.
 */
const TARGET_KEYS = ['skuId', 'sessionId', 'storeId', 'runId', 'expenseId'] as const;

export function pendingChangeCount(
  entries: readonly { clientSeq: number; procedure: string; input: unknown }[],
): number {
  const keys = new Set<string>();
  for (const e of entries) {
    const input = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
    const parts = TARGET_KEYS.map((k) => (typeof input[k] === 'string' ? (input[k] as string) : ''));
    keys.add(parts.some(Boolean) ? `${e.procedure}|${parts.join('|')}` : `#${e.clientSeq}`);
  }
  return keys.size;
}
