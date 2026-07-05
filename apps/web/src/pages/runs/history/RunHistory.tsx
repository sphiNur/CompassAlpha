/**
 * Run history subsystem — extracted verbatim from RunPage.tsx
 * (Phase 4 step 2, FRONTEND_AUDIT_2026-07.md run-domain split).
 *
 *   - RunHistorySection    inline "recent finished runs" card at the
 *                          bottom of RunPage (month-grouped, capped).
 *   - RunHistoryPage       full-history drill page ("View all").
 *   - RunHistoryDetailSheet per-run breakdown sheet (items, prices,
 *                          per-store settlement) — used by both.
 *
 * Read-only: one run.get query, no mutations. Money math comes from
 * ../lib/settlement (unit-tested).
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, CardHeader, CardTitle, SectionLabel, Sheet } from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatQty } from '../../../lib/format';
import type { useI18n, useProductName } from '../../../hooks/useI18n';
import { splitPaymentMethod, splitSubtotal, settleItemLine } from '../lib/settlement';

// ====================================================================
// HISTORY VIEW
// ====================================================================
// The user explicitly asked: "配送完成、验货完成之后需要入档,需要能看到
// 每天购买的记录,数量价格这些都要能看到历史记录" — after delivery and
// confirmation, sessions should be archived; we need to see daily
// purchase history, quantities, prices.
//
// Implementation: the existing run.list endpoint already returns the
// last 50 runs (any status). We filter for finished+cancelled here and
// render them in a card. Tapping a row opens the detail sheet which
// fetches run.get for the full breakdown (items, prices, store splits).

export interface RunListRow {
  id: string;
  runDate: string;
  runIndex: number;
  status: string;
  actualTotal: string | null;
  /** M1.14: cash + transfer breakdown of actualTotal. Both NULL on
   *  legacy finished runs that pre-date the field; FE falls back to
   *  showing only the lump-sum total in that case. */
  actualCashTotal?: string | null;
  actualTransferTotal?: string | null;
  finishedAt: Date | string | null;
  storeTotals?: RunListStoreTotal[];
}

export interface RunListStoreTotal {
  storeId: string;
  total: string;
  cash: string;
  transfer: string;
  itemCount: number;
}

export interface HistoryDetailTarget {
  runId: string;
  runIndex: number;
  runDate: string;
  status: string;
  /** When a user opens a store from the history list, land directly on
   * that branch's daily purchase list instead of the combined run. */
  initialStoreId?: string | null;
}

export function RunHistorySection({
  runs,
  storeById,
  i18n,
  onOpenAll,
  onOpen,
}: {
  runs: RunListRow[];
  productName: ReturnType<typeof useProductName>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  onOpenAll: () => void;
  onOpen: (r: RunListRow) => void;
}) {
  // M3.9 (2026-05-16): cancelled runs are hidden from this list
  // entirely. The earlier UX had a 3-tab filter (finished / all /
  // cancelled) but the user's mental model is "history = completed
  // outcomes; a cancelled run didn't happen — please erase it."
  // Cancellations stay in the event log + read model so admins can
  // dig them up via Operations → Submission history if forensics
  // are ever needed; here they just vanish. No localStorage state,
  // no filter chip toolbar, no count badges.
  const allHistorical = useMemo(
    () => runs.filter((r) => r.status === 'finished'),
    [runs],
  );
  // M1.13 (2026-05-08): cap the inline list at 12 rows. Anything older
  // is reachable via the "View all" link → Operations → Submission
  // history (which already has full pagination, search, filters).
  // Keeps RunPage's bottom from becoming an infinite scroll dump.
  const HISTORY_INLINE_CAP = 12;

  // Group by yyyy-mm so the section reads as a calendar
  // ("May 2026 · 8 runs · ₸4,250,000 / April 2026 · 12 runs · ...").
  const groups = useMemo(() => {
    const capped = allHistorical.slice(0, HISTORY_INLINE_CAP);
    const byMonth = new Map<string, RunListRow[]>();
    for (const r of capped) {
      // runDate is stored as "YYYY-MM-DD" — slice the year+month prefix.
      const key = r.runDate.slice(0, 7);
      const arr = byMonth.get(key) ?? [];
      arr.push(r);
      byMonth.set(key, arr);
    }
    return [...byMonth.entries()].map(([month, rows]) => {
      const total = rows.reduce(
        (sum, r) =>
          sum + (r.actualTotal ? Number(r.actualTotal) : 0),
        0,
      );
      return { month, rows, total };
    });
  }, [allHistorical]);

  const totalShown = groups.reduce((s, g) => s + g.rows.length, 0);
  const hasMore = allHistorical.length > totalShown;

  if (allHistorical.length === 0) return null;

  // Format yyyy-mm into the user's locale month-year ("May 2026" / "2026年5月").
  const formatMonth = (key: string): string => {
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{i18n.t('run.history.title')}</CardTitle>
        <button
          type="button"
          onClick={onOpenAll}
          className="shrink-0 text-label font-semibold text-[var(--c-action)] active:opacity-70"
        >
          {i18n.t('run.history.viewAll')}
        </button>
      </CardHeader>
      {/* M3.9: filter chip toolbar removed — cancelled runs no
         longer surface here, so there's nothing to toggle. */}
      {groups.map((g) => (
        <section key={g.month} className="border-t border-[var(--c-divider)] first:border-t-0">
          {/* Month group header — sub-section label + per-month total
              spend for finished runs. Helps the operator see "we spent
              X this month" without leaving the page. */}
          {/* M2.1: SectionLabel (month group header). */}
          <SectionLabel
            meta={g.total > 0 ? formatMoney(String(g.total)) : undefined}
            className="pt-3 pb-1"
          >
            {formatMonth(g.month)}
          </SectionLabel>
          <ul className="flex flex-col" role="list">
            {/* M3.9: cancelled-row branches dropped — `allHistorical`
               above filters to status==='finished' only, so the dead
               code that used to render the ❌ badge + cancelled-reason
               line is gone. If forensics ever needs to surface
               cancelled runs back here, both the FE filter and the
               row branches need restoring together. */}
            {g.rows.map((r) => {
              const storeTotals = (r.storeTotals ?? []).filter((st) => Number(st.total) > 0);
              return (
              <li
                key={r.id}
                className="border-b border-[var(--c-divider)] last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left active:bg-[var(--c-surface-2)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-semibold tabular-nums">
                        {r.runDate}
                      </span>
                      {r.runIndex > 0 ? (
                        <span className="text-label text-[var(--c-fg-muted)]">
                          #{r.runIndex + 1}
                        </span>
                      ) : null}
                    </div>
                    {r.actualTotal ? (
                      <div className="text-label text-[var(--c-fg-muted)]">
                        {i18n.t('run.history.totalLine', {
                          total: formatMoney(r.actualTotal),
                        })}
                        {/* M1.14: when this run mixed both methods,
                            surface a tiny "💵 X · 🏦 Y" breakdown so
                            the operator can see split at a glance.
                            Hidden when one bucket is zero (single-
                            method run) or both columns are NULL
                            (legacy run pre-M1.14). */}
                        {r.actualCashTotal != null &&
                        r.actualTransferTotal != null &&
                        Number(r.actualCashTotal) > 0 &&
                        Number(r.actualTransferTotal) > 0 ? (
                          <span className="ml-1 text-label">
                            {' · '}💵 {formatMoney(r.actualCashTotal)}
                            {' · '}🏦 {formatMoney(r.actualTransferTotal)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {storeTotals.length > 1 ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {storeTotals.map((st) => {
                          const storeName =
                            storeById.get(st.storeId)?.name ?? st.storeId.slice(0, 8);
                          return (
                            <span
                              key={st.storeId}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--c-bg)] px-1.5 py-0.5 text-label ring-1 ring-[var(--c-divider)]"
                            >
                              <span className="max-w-[8rem] truncate font-medium text-[var(--c-fg)]">
                                {storeName}
                              </span>
                              <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                                {formatMoney(st.total)}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </button>
              </li>
              );
            })}
          </ul>
        </section>
      ))}
      {/* "View all" tail — only when truncated. Routes the user to
          Operations → Submission history (the proper paginated view)
          rather than dumping infinite scroll into RunPage. */}
      {hasMore ? (
        <div className="border-t border-[var(--c-divider)] px-4 py-2 text-center text-label text-[var(--c-fg-muted)]">
          {i18n.t('run.history.viewAllHint')}
        </div>
      ) : null}
    </Card>
  );
}

export function RunHistoryPage({
  runs,
  loading,
  storeById,
  skuById,
  productName,
  i18n,
  onBack,
}: {
  runs: RunListRow[];
  loading: boolean;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  onBack: () => void;
}) {
  const [detailFor, setDetailFor] = useState<HistoryDetailTarget | null>(null);
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const total = runs.reduce((sum, run) => sum + Number(run.actualTotal ?? 0), 0);

  return (
    <div className="flex flex-col gap-3 px-4 pb-24 pt-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-[var(--r-pill)] px-2 py-1 text-label font-semibold text-[var(--c-action)] active:bg-[var(--c-surface-2)]"
        >
          {i18n.t('common.back')}
        </button>
        <h1 className="text-h2 font-semibold text-[var(--c-fg)]">{i18n.t('run.history.title')}</h1>
      </div>
      <Card>
        <SectionLabel meta={`${runs.length} · ${formatMoney(total)} ${currency}`}>
          {i18n.t('run.history.title')}
        </SectionLabel>
        {loading ? (
          <div className="px-4 py-6 text-center text-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('common.loading')}
          </div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-6 text-center text-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('run.history.subtitle')}
          </div>
        ) : (
          <ul className="flex flex-col" role="list">
            {runs.map((run) => (
              <li key={run.id} className="border-b border-[var(--c-divider)] last:border-b-0">
                <button
                  type="button"
                  onClick={() =>
                    setDetailFor({
                      runId: run.id,
                      runIndex: run.runIndex,
                      runDate: run.runDate,
                      status: run.status,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-[var(--c-surface-2)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-semibold tabular-nums">
                      {run.runDate}
                      {run.runIndex > 0 ? ` #${run.runIndex + 1}` : ''}
                    </div>
                    <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                      {run.actualTotal
                        ? i18n.t('run.history.totalLine', {
                            total: formatMoney(run.actualTotal),
                          })
                        : '—'}
                    </div>
                  </div>
                  <Badge tone="success">{run.status}</Badge>
                </button>
                {(run.storeTotals?.length ?? 0) > 0 ? (
                  <div className="border-t border-[var(--c-divider)] px-4 py-2.5">
                    <div className="mb-1.5 text-label font-semibold text-[var(--c-fg-muted)]">
                      {i18n.t('run.history.storePurchases')}
                    </div>
                    <div className="flex flex-col gap-1">
                      {run.storeTotals!.map((storeTotal) => {
                        const storeName =
                          storeById.get(storeTotal.storeId)?.name ?? storeTotal.storeId.slice(0, 8);
                        return (
                          <button
                            key={storeTotal.storeId}
                            type="button"
                            onClick={() =>
                              setDetailFor({
                                runId: run.id,
                                runIndex: run.runIndex,
                                runDate: run.runDate,
                                status: run.status,
                                initialStoreId: storeTotal.storeId,
                              })
                            }
                            // Flattened (2026-07-05): dropped the nested
                            // rounded-card + ring-hairline + surface-2
                            // (a card inside the history Card). These rows
                            // already sit in the Card's own bordered
                            // region, so a plain row reads cleaner.
                            className="flex min-h-10 w-full items-center justify-between gap-3 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
                          >
                            <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                              {storeName}
                            </span>
                            <span className="shrink-0 text-label text-[var(--c-fg-muted)]">
                              {i18n.t('run.label.itemsCount', { n: storeTotal.itemCount })}
                            </span>
                            <span className="shrink-0 font-mono text-label font-semibold tabular-nums">
                              {formatMoney(storeTotal.total)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <RunHistoryDetailSheet
        target={detailFor}
        skuById={skuById}
        storeById={storeById}
        productName={productName}
        i18n={i18n}
        onClose={() => setDetailFor(null)}
      />
    </div>
  );
}

/**
 * Drill-down sheet for one historical run.
 *
 * Fetches `run.get` lazily when opened. Shows:
 *   - Status + total + finished-at timestamp at the top
 *   - Per-item rows: name, qty bought, unit price, line total, supplier
 *   - Per-store breakdown: items received, store-level subtotal
 *
 * Receipt photos are shown inline (clickable to expand to full size — TODO
 * once we have a lightbox component).
 */
export function RunHistoryDetailSheet({
  target,
  skuById,
  storeById,
  productName,
  i18n,
  onClose,
}: {
  target: HistoryDetailTarget | null;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  onClose: () => void;
}) {
  // M1.21: org-wide currency for the headline label.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const detail = trpc.run.get.useQuery(
    target ? { runId: target.runId } : { runId: '' },
    { enabled: !!target },
  );
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedStoreId(target?.initialStoreId ?? null);
  }, [target?.initialStoreId, target?.runId]);

  const breakdown = useMemo(() => {
    if (!detail.data) return null;
    const items = detail.data.items;
    const splits = detail.data.splits;
    const perStoreDemand = detail.data.perStoreDemand ?? [];
    const expenses = detail.data.expenses ?? [];
    let total = 0;
    let totalCash = 0;
    let totalTransfer = 0;
    const purchasedCount = items.filter((i) => i.status === 'purchased').length;
    const unavailableCount = items.filter((i) => i.status === 'unavailable').length;
    for (const it of items) {
      if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
        const itemSplits = splits.filter((sp) => sp.skuId === it.skuId);
        const { line, cash, transfer } = settleItemLine(it, itemSplits);
        total += line;
        totalCash += cash;
        totalTransfer += transfer;
      }
    }
    // M3.44: off-catalog expenses contribute to the run total + the
    // payment-method breakdown the same way SKU buys do.
    for (const ex of expenses) {
      const line = Number(ex.qty) * Number(ex.unitPrice);
      total += line;
      if (ex.paymentMethod === 'transfer') totalTransfer += line;
      else totalCash += line;
    }
    /**
     * M3.52 (2026-05-23): per-store settlement — strictly each store's
     * own slice, NEVER mixed across stores. The user's pain point:
     * "采购完成后的结算也记得严格按照每家店的清单来结算，别相互混淆了"
     * — after finish, the manager must see X for store-A and Y for
     * store-B without any cross-contamination.
     *
     * Each store row aggregates:
     *   - SKU lines: their split of `unitPrice × splits.qty` for every
     *     purchased item, broken into cash/transfer by the item's
     *     payment method.
     *   - Expenses: their slice of `unitPrice × storeSplits.qty` for
     *     every off-catalog expense, payment-method tracked too.
     *
     * `itemCount` counts UNIQUE skuIds that touched this store (was
     * "split rows" before, which double-counted when the run had
     * multiple delivery cycles in legacy data).
     */
    const perStore = new Map<
      string,
      {
        storeId: string;
        total: number;
        cash: number;
        transfer: number;
        skuIds: Set<string>;
        expensesTotal: number;
        expensesCount: number;
      }
    >();
    const ensureStore = (storeId: string) => {
      let cur = perStore.get(storeId);
      if (!cur) {
        cur = {
          storeId,
          total: 0,
          cash: 0,
          transfer: 0,
          skuIds: new Set<string>(),
          expensesTotal: 0,
          expensesCount: 0,
        };
        perStore.set(storeId, cur);
      }
      return cur;
    };
    for (const sp of splits) {
      const item = items.find((i) => i.skuId === sp.skuId);
      if (!item || item.status !== 'purchased' || !item.unitPrice) continue;
      const subtotal = splitSubtotal(sp, item);
      const cur = ensureStore(sp.storeId);
      cur.total += subtotal;
      if (splitPaymentMethod(sp, item) === 'transfer') cur.transfer += subtotal;
      else cur.cash += subtotal;
      cur.skuIds.add(sp.skuId);
    }
    for (const ex of expenses) {
      for (const ss of ex.storeSplits) {
        const subtotal = Number(ss.qty) * Number(ex.unitPrice);
        const cur = ensureStore(ss.storeId);
        cur.total += subtotal;
        cur.expensesTotal += subtotal;
        cur.expensesCount += 1;
        if (ex.paymentMethod === 'transfer') cur.transfer += subtotal;
        else cur.cash += subtotal;
      }
    }
    return {
      items,
      splits,
      perStoreDemand,
      expenses,
      total,
      totalCash,
      totalTransfer,
      purchasedCount,
      unavailableCount,
      perStore,
    };
  }, [detail.data]);

  const storeOptions = useMemo(() => {
    if (!breakdown) return [];
    return [...breakdown.perStore.values()].sort((a, b) => b.total - a.total);
  }, [breakdown]);

  const activeStoreId =
    selectedStoreId && breakdown?.perStore.has(selectedStoreId) ? selectedStoreId : null;
  const activeStoreTotal =
    activeStoreId && breakdown ? breakdown.perStore.get(activeStoreId) ?? null : null;

  type HistoryBreakdown = NonNullable<typeof breakdown>;
  type HistoryItem = HistoryBreakdown['items'][number];
  type HistorySplit = HistoryBreakdown['splits'][number];
  type VisibleHistoryRow = {
    item: HistoryItem;
    qty: string | null;
    lineTotal: number;
    perStoreSplits: HistorySplit[];
  };

  const visibleHistoryRows = useMemo<VisibleHistoryRow[]>(() => {
    if (!breakdown) return [];
    if (!activeStoreId) {
      return breakdown.items.map((item) => ({
        item,
        qty: item.purchasedQty,
        lineTotal:
          item.status === 'purchased' && item.unitPrice && item.purchasedQty
            ? breakdown.splits
                .filter((sp) => sp.skuId === item.skuId)
                .reduce((sum, sp) => sum + splitSubtotal(sp, item), 0) ||
              Number(item.unitPrice) * Number(item.purchasedQty)
            : 0,
        perStoreSplits: breakdown.splits.filter((sp) => sp.skuId === item.skuId),
      }));
    }

    const demandBySku = new Map(
      breakdown.perStoreDemand
        .filter((d) => d.storeId === activeStoreId)
        .map((d) => [d.skuId, d.qty] as const),
    );
    return breakdown.items.flatMap<VisibleHistoryRow>((item) => {
      if (item.status === 'purchased') {
        const split = breakdown.splits.find(
          (sp) => sp.storeId === activeStoreId && sp.skuId === item.skuId,
        );
        if (!split) return [];
        return [
          {
            item,
            qty: split.qty,
            lineTotal: splitSubtotal(split, item),
            perStoreSplits: [split],
          },
        ];
      }
      if (item.status === 'unavailable' && demandBySku.has(item.skuId)) {
        return [
          {
            item,
            qty: demandBySku.get(item.skuId) ?? null,
            lineTotal: 0,
            perStoreSplits: [],
          },
        ];
      }
      return [];
    });
  }, [activeStoreId, breakdown]);

  const visiblePurchasedCount = activeStoreId
    ? visibleHistoryRows.filter((row) => row.item.status === 'purchased').length
    : breakdown?.purchasedCount ?? 0;
  const visibleUnavailableCount = activeStoreId
    ? visibleHistoryRows.filter((row) => row.item.status === 'unavailable').length
    : breakdown?.unavailableCount ?? 0;
  const headlineTotal = activeStoreTotal?.total ?? breakdown?.total ?? 0;
  const headlineCash = activeStoreTotal?.cash ?? breakdown?.totalCash ?? 0;
  const headlineTransfer = activeStoreTotal?.transfer ?? breakdown?.totalTransfer ?? 0;
  const headlineStoreCount = activeStoreId ? 1 : breakdown?.perStore.size ?? 0;
  const activeStoreName = activeStoreId
    ? storeById.get(activeStoreId)?.name ?? activeStoreId.slice(0, 8)
    : null;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={
        target
          ? `${target.runDate}${target.runIndex > 0 ? ` #${target.runIndex + 1}` : ''}`
          : ''
      }
      description={target?.status ?? undefined}
    >
      {!target ? null : detail.isLoading ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          {i18n.t('common.loading')}
        </div>
      ) : !breakdown ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          {i18n.t('common.noData')}
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-3">
          {/* Top summary */}
          <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <SectionLabel padded={false}>
                  {i18n.t('run.history.totalLabel')}
                </SectionLabel>
                {/* M2.2: headline money unified to text-h2 (17 px)
                    across pages. Was text-h1 (22 px) — only Order's
                    estimate and Admin's sales tiles use text-h2 for
                    the same role, so the history headline felt
                    oversized by comparison. */}
                <div className="font-mono text-h2 font-semibold tabular-nums">
                  {formatMoney(headlineTotal)} {currency}
                </div>
              </div>
              <div className="text-right text-label text-[var(--c-fg-muted)]">
                {i18n.t('run.history.itemSummary', {
                  bought: visiblePurchasedCount,
                  na: visibleUnavailableCount,
                })}
                <br />
                {i18n.t('run.history.storeSummary', { stores: headlineStoreCount })}
              </div>
            </div>
            {/* M1.14: payment-method breakdown row. Only renders when
                the run actually mixed both methods — pure-cash and
                pure-transfer runs are unambiguous from the lump sum. */}
            {headlineCash > 0 && headlineTransfer > 0 ? (
              <div className="flex items-baseline gap-3 border-t border-[var(--c-divider)] pt-2 text-label">
                <span className="text-[var(--c-fg-muted)]">
                  {i18n.t('run.label.paymentCash')}
                </span>
                <span className="font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(headlineCash)}
                </span>
                <span className="ml-auto text-[var(--c-fg-muted)]">
                  {i18n.t('run.label.paymentTransfer')}
                </span>
                <span className="font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(headlineTransfer)}
                </span>
              </div>
            ) : null}
          </div>

          {storeOptions.length > 1 ? (
            <div className="flex gap-1 overflow-x-auto rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-1 ring-hairline">
              <button
                type="button"
                aria-pressed={!activeStoreId}
                onClick={() => setSelectedStoreId(null)}
                className={
                  !activeStoreId
                    ? 'shrink-0 rounded-[var(--r-pill)] bg-[var(--c-bg)] px-3 py-1.5 text-label font-medium text-[var(--c-fg)] shadow-sm'
                    : 'shrink-0 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium text-[var(--c-fg-muted)]'
                }
              >
                {i18n.t('run.history.allStores')}
              </button>
              {storeOptions.map((storeTotal) => {
                const storeName =
                  storeById.get(storeTotal.storeId)?.name ?? storeTotal.storeId.slice(0, 8);
                const selected = activeStoreId === storeTotal.storeId;
                return (
                  <button
                    key={storeTotal.storeId}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedStoreId(storeTotal.storeId)}
                    className={
                      selected
                        ? 'shrink-0 rounded-[var(--r-pill)] bg-[var(--c-bg)] px-3 py-1.5 text-label font-medium text-[var(--c-fg)] shadow-sm'
                        : 'shrink-0 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium text-[var(--c-fg-muted)]'
                    }
                  >
                    <span className="inline-block max-w-[9rem] truncate align-bottom">
                      {storeName}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Per-item rows.
              M3.52 (2026-05-23): each purchased row now also surfaces
              the per-store qty split as compact chips, matching the
              in-run PurchaseRow view. Without this the history sheet
              showed "5kg apples" with no way to see the 2kg-for-A
              + 3kg-for-B breakdown — managers couldn't reconcile
              the per-store totals against individual line items. */}
          <div>
            <SectionLabel padded={false} className="mb-2">
              {activeStoreName
                ? i18n.t('run.history.storeItemsHeading', { store: activeStoreName })
                : i18n.t('run.history.itemsHeading')}
            </SectionLabel>
            <ul className="flex flex-col rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline">
              {visibleHistoryRows.length === 0 ? (
                <li className="px-4 py-3 text-center text-label text-[var(--c-fg-muted)]">
                  {i18n.t('common.noData')}
                </li>
              ) : null}
              {visibleHistoryRows.map((row) => {
                const it = row.item;
                const sku = skuById.get(it.skuId);
                const skuName = sku ? productName(sku) : it.skuId.slice(0, 8);
                const lineTotal = row.lineTotal;
                const perStoreSplits = row.perStoreSplits;
                const isMulti = !activeStoreId && breakdown.perStore.size > 1;
                return (
                  <li
                    key={it.skuId}
                    className="border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-semibold">{skuName}</span>
                      {it.status === 'purchased' ? (
                        <span className="font-mono text-body font-semibold tabular-nums">
                          {formatMoney(lineTotal)}
                        </span>
                      ) : (
                        <Badge tone="danger">{i18n.t('run.action.markNa')}</Badge>
                      )}
                    </div>
                    <div className="text-label text-[var(--c-fg-muted)]">
                      {activeStoreId ? (
                        it.status === 'purchased'
                          ? `${formatQty(row.qty)} ${sku?.unit ?? ''} x ${formatMoney(it.unitPrice)}`
                          : it.unavailableNote ?? ''
                      ) : (
                        <>
                          {it.status === 'purchased'
                            ? `${formatQty(it.purchasedQty)} ${sku?.unit ?? ''} × ${formatMoney(it.unitPrice)}`
                            : it.unavailableNote ?? ''}
                        </>
                      )}
                    </div>
                    {/* M3.52: per-store chips on history rows. Same
                       visual pattern as the in-run PurchaseRow chips. */}
                    {isMulti && it.status === 'purchased' && perStoreSplits.length > 0 ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {perStoreSplits.map((sp) => {
                          const storeName =
                            storeById.get(sp.storeId)?.name ?? sp.storeId.slice(0, 8);
                          return (
                            <span
                              key={sp.storeId}
                              className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-bg)] px-1.5 py-0.5 text-label ring-1 ring-[var(--c-divider)]"
                            >
                              <span className="font-medium text-[var(--c-fg)]">
                                {storeName}
                              </span>
                              <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                                {formatQty(sp.qty)} {sku?.unit ?? ''}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Per-store breakdown — settlement view.
              M3.52 (2026-05-23): each row is one store's strict slice
              of the run cost (SKU lines + expense splits, never
              mixing). Shows item count, cash/transfer split when
              mixed, and any off-catalog expenses attributed to the
              store. This is the manager's source of truth for
              reconciling who owes what after the run finishes. */}
          {breakdown.perStore.size > 0 ? (
            <div>
              <SectionLabel padded={false} className="mb-2">
                {i18n.t('run.history.storesHeading')}
              </SectionLabel>
              <ul className="flex flex-col rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline">
                {[...breakdown.perStore.values()]
                  .filter((ps) => !activeStoreId || ps.storeId === activeStoreId)
                  .sort((a, b) => b.total - a.total)
                  .map((ps) => {
                    const store = storeById.get(ps.storeId);
                    const mixed = ps.cash > 0 && ps.transfer > 0;
                    return (
                      <li
                        key={ps.storeId}
                        className="flex flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-body font-semibold">
                              {store?.name ?? ps.storeId.slice(0, 8)}
                            </div>
                            <div className="text-label text-[var(--c-fg-muted)]">
                              {/* M3.52 i18n fix: was hardcoded "items"
                                 string; now uses the localized plural
                                 key shared with the rest of the app.
                                 Counts UNIQUE SKUs delivered to this
                                 store, not split rows. */}
                              {i18n.t('run.label.itemsCount', {
                                n: ps.skuIds.size,
                              })}
                              {ps.expensesCount > 0 ? (
                                <>
                                  {' · '}
                                  {i18n.t('run.confirm.finish.expenses', {
                                    n: ps.expensesCount,
                                    total: formatMoney(ps.expensesTotal),
                                  })}
                                </>
                              ) : null}
                            </div>
                          </div>
                          <span className="font-mono text-body font-semibold tabular-nums">
                            {formatMoney(ps.total)}
                          </span>
                        </div>
                        {mixed ? (
                          <div className="flex items-baseline gap-3 text-label text-[var(--c-fg-muted)]">
                            <span>💵 {formatMoney(ps.cash)}</span>
                            <span>🏦 {formatMoney(ps.transfer)}</span>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
