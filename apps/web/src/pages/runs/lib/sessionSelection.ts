/**
 * 2026-10-21 CA-03: which approved orders go into a run.
 *
 * "Start purchasing" used to take EVERY approved session the purchaser
 * could see, regardless of order date, and the preview never showed a
 * date. A store's order from three days ago that nobody bought was
 * silently bought again with today's — and the whole spend was booked
 * under today.
 *
 * Now the preview groups sessions by order date, today's (org timezone,
 * from the server) are ticked by default, older ones are visible but
 * unticked, and the purchaser can tick sessions individually or a whole
 * date group. The same rules drive the "N new orders — join" banner of a
 * run that is already buying.
 *
 * Pure functions; tests in __tests__/sessionSelection.test.ts.
 */

export type SelectableSession = {
  id: string;
  storeId: string;
  storeName?: string;
  orderDate?: string;
};

export type SessionDateGroup<S extends SelectableSession> = {
  /** YYYY-MM-DD, or '' for a session without a date. */
  date: string;
  isToday: boolean;
  sessions: S[];
};

/** Per-session override of the default; absent = default (today ⇒ ticked). */
export type SessionOverrides = ReadonlyMap<string, boolean>;

export function isDefaultSelected(session: SelectableSession, today: string | null): boolean {
  return !!today && session.orderDate === today;
}

/** The ids currently ticked: overrides win, everything else follows the default. */
export function selectedSessionIds(
  sessions: readonly SelectableSession[],
  today: string | null,
  overrides: SessionOverrides,
): string[] {
  return sessions
    .filter((s) => overrides.get(s.id) ?? isDefaultSelected(s, today))
    .map((s) => s.id);
}

/** Newest date first; within a date, by store name. */
export function groupSessionsByDate<S extends SelectableSession>(
  sessions: readonly S[],
  today: string | null,
): Array<SessionDateGroup<S>> {
  const byDate = new Map<string, S[]>();
  for (const s of sessions) {
    const key = s.orderDate ?? '';
    const list = byDate.get(key) ?? [];
    list.push(s);
    byDate.set(key, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({
      date,
      isToday: !!today && date === today,
      sessions: [...list].sort((a, b) => (a.storeName ?? '').localeCompare(b.storeName ?? '')),
    }));
}

/** Tick / untick every session of one date group. */
export function withGroupSelection(
  overrides: SessionOverrides,
  group: { sessions: readonly SelectableSession[] },
  checked: boolean,
): Map<string, boolean> {
  const next = new Map(overrides);
  for (const s of group.sessions) next.set(s.id, checked);
  return next;
}

/** Whole days between an order date and today (0 for today / unknown). */
export function daysOld(date: string, today: string | null): number {
  if (!today || !date) return 0;
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

type PreviewShape = {
  sessions: ReadonlyArray<SelectableSession & { notes?: string | null }>;
  plannedItems: ReadonlyArray<{ skuId: string; qty: string }>;
  perStoreDemand: ReadonlyArray<{ storeId: string; storeName: string; skuId: string; qty: string }>;
  perSessionDemand?: ReadonlyArray<{ sessionId: string; skuId: string; qty: string }>;
  supplierBySku: Record<string, { estimatedUnitPrice?: string | null } | null>;
  lastPurchasePriceBySku?: Record<string, string>;
  perStoreBudgets?: ReadonlyArray<{
    storeId: string;
    storeName: string;
    estimatedTotal: string;
    unknownPriceCount: number;
  }>;
  sessionNotesByStore?: Record<string, string>;
  sessionExtrasByStore?: Record<string, ReadonlyArray<{ sessionId?: string }>>;
};

/**
 * Re-aggregate the server preview over the ticked sessions only, keeping
 * its shape so PreviewSummaryCard renders exactly what will be planned.
 * Mirrors run.previewCreatable's aggregation (qty sums, budget =
 * Σ qty × (last purchase price ?? supplier estimate), unknown-price count).
 *
 * An old server without `perSessionDemand` cannot be re-aggregated; the
 * preview is returned unchanged (as before CA-03).
 */
export function selectPreview<P extends PreviewShape>(
  preview: P,
  selectedIds: readonly string[],
): P {
  if (!preview.perSessionDemand) return preview;
  const selected = new Set(selectedIds);
  const sessions = preview.sessions.filter((s) => selected.has(s.id));
  const storeBySession = new Map(sessions.map((s) => [s.id, s.storeId]));
  const storeNameById = new Map<string, string>();
  for (const d of preview.perStoreDemand) storeNameById.set(d.storeId, d.storeName);
  for (const s of sessions) if (s.storeName) storeNameById.set(s.storeId, s.storeName);

  const aggregated = new Map<string, number>();
  const perStore = new Map<string, Map<string, number>>();
  for (const d of preview.perSessionDemand) {
    const storeId = storeBySession.get(d.sessionId);
    if (!storeId) continue;
    const qty = Number(d.qty);
    if (!(qty > 0)) continue;
    aggregated.set(d.skuId, (aggregated.get(d.skuId) ?? 0) + qty);
    const inner = perStore.get(storeId) ?? new Map<string, number>();
    inner.set(d.skuId, (inner.get(d.skuId) ?? 0) + qty);
    perStore.set(storeId, inner);
  }

  const perStoreDemand: Array<{ storeId: string; storeName: string; skuId: string; qty: string }> =
    [];
  for (const [storeId, inner] of perStore) {
    for (const [skuId, qty] of inner) {
      perStoreDemand.push({
        storeId,
        storeName: storeNameById.get(storeId) ?? '—',
        skuId,
        qty: qty.toString(),
      });
    }
  }

  const involvedStoreIds = [...new Set([...perStore.keys(), ...sessions.map((s) => s.storeId)])];
  const perStoreBudgets = involvedStoreIds.map((storeId) => {
    let estimatedTotal = 0;
    let unknownPriceCount = 0;
    for (const [skuId, qty] of perStore.get(storeId) ?? []) {
      const price =
        preview.lastPurchasePriceBySku?.[skuId] ??
        preview.supplierBySku[skuId]?.estimatedUnitPrice ??
        null;
      if (!price) {
        unknownPriceCount += 1;
        continue;
      }
      estimatedTotal += qty * Number(price);
    }
    return {
      storeId,
      storeName: storeNameById.get(storeId) ?? '—',
      estimatedTotal: estimatedTotal.toFixed(2),
      unknownPriceCount,
    };
  });

  const selectedStores = new Set(sessions.map((s) => s.storeId));
  const sessionNotesByStore: Record<string, string> = {};
  for (const s of sessions) {
    const note = (s.notes ?? '').trim();
    if (!note) continue;
    sessionNotesByStore[s.storeId] = sessionNotesByStore[s.storeId]
      ? `${sessionNotesByStore[s.storeId]}\n\n${note}`
      : note;
  }
  const sessionExtrasByStore: Record<string, Array<{ sessionId?: string }>> = {};
  for (const [storeId, extras] of Object.entries(preview.sessionExtrasByStore ?? {})) {
    if (!selectedStores.has(storeId)) continue;
    const kept = extras.filter((ex) => !ex.sessionId || selected.has(ex.sessionId));
    if (kept.length > 0) sessionExtrasByStore[storeId] = kept;
  }

  return {
    ...preview,
    sessions,
    plannedItems: [...aggregated.entries()].map(([skuId, qty]) => ({ skuId, qty: qty.toString() })),
    perStoreDemand,
    perStoreBudgets,
    sessionNotesByStore,
    sessionExtrasByStore,
  } as P;
}
