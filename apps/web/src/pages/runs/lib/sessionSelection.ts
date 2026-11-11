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
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';

export type SelectableSession = {
  id: string;
  storeId: string;
  storeName?: string;
  orderDate?: string;
  /** Who sent the order (F6, 2026-11-05); absent from older servers. */
  submittedByName?: string | null;
  submittedAt?: string | null;
};

/**
 * Walkthrough F6 (2026-11-05): "第 N 批" for each session of a store that
 * has more than one in the same date group, in the order they were sent.
 * Sessions alone in their store/date get no number.
 */
export function batchNumbers(sessions: readonly SelectableSession[]): Map<string, number> {
  const byStoreDate = new Map<string, SelectableSession[]>();
  for (const s of sessions) {
    const k = `${s.storeId}|${s.orderDate ?? ''}`;
    const list = byStoreDate.get(k);
    if (list) list.push(s);
    else byStoreDate.set(k, [s]);
  }
  const out = new Map<string, number>();
  for (const list of byStoreDate.values()) {
    if (list.length < 2) continue;
    [...list]
      .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '') || a.id.localeCompare(b.id))
      .forEach((s, i) => out.set(s.id, i + 1));
  }
  return out;
}

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
  /** The UI language store names are sorted in (RUNWEB2-30). */
  locale?: string,
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
      sessions: [...list].sort((a, b) =>
        (a.storeName ?? '').localeCompare(b.storeName ?? '', locale),
      ),
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

export type PreviewShape = {
  sessions: ReadonlyArray<SelectableSession & { notes?: string | null }>;
  plannedItems: ReadonlyArray<{ skuId: string; qty: string }>;
  perStoreDemand: ReadonlyArray<{ storeId: string; storeName: string; skuId: string; qty: string }>;
  perSessionDemand?: ReadonlyArray<{ sessionId: string; skuId: string; qty: string }>;
  perStoreBudgets?: ReadonlyArray<unknown>;
  sessionNotesByStore?: Record<string, string>;
  sessionExtrasByStore?: Record<string, ReadonlyArray<{ sessionId?: string }>>;
};

/**
 * Re-aggregate the server preview over the ticked sessions only, keeping
 * its shape so PreviewSummaryCard renders exactly what will be planned.
 * Quantities are summed exactly, in thousandths, as run.previewCreatable
 * sums them (RUNAPI-05): two orders of 0.1 and 0.2 kg are 0.3 kg, not
 * 0.30000000000000004.
 *
 * Budgets are not re-aggregated, and the selection carries none rather
 * than the whole day's: no screen reads them (the card prices its own
 * lines, see previewStats). Review RUNWEB2-12 (2026-11-11): this kept a
 * copy of the server's budget rule, up to date by hand, which had drifted
 * from it and was read by nobody.
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

  const aggregated = new Map<string, bigint>();
  const perStore = new Map<string, Map<string, bigint>>();
  for (const d of preview.perSessionDemand) {
    const storeId = storeBySession.get(d.sessionId);
    if (!storeId) continue;
    const qty = qtyMilliOrZero(d.qty);
    if (qty <= 0n) continue;
    aggregated.set(d.skuId, (aggregated.get(d.skuId) ?? 0n) + qty);
    const inner = perStore.get(storeId) ?? new Map<string, bigint>();
    inner.set(d.skuId, (inner.get(d.skuId) ?? 0n) + qty);
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
        qty: milliQty(qty),
      });
    }
  }

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
    plannedItems: [...aggregated.entries()].map(([skuId, qty]) => ({ skuId, qty: milliQty(qty) })),
    perStoreDemand,
    perStoreBudgets: [],
    sessionNotesByStore,
    sessionExtrasByStore,
  } as P;
}
