/**
 * Run history subsystem — extracted verbatim from RunPage.tsx
 * (Phase 4 step 2, FRONTEND_AUDIT_2026-07.md run-domain split).
 *
 *   - RunHistoryPage       the history screen itself (list + totals).
 *   - RunHistoryDetailSheet per-run breakdown sheet (items, prices,
 *                          per-store settlement).
 *
 * 2026-07-30: `RunHistorySection` — the summary card that used to sit
 * at the bottom of RunPage — is gone. History is its own bottom-nav
 * tab now (pages/HistoryPage.tsx), so the card had no caller: its
 * whole job was to be the doorway from the run page, and that doorway
 * was also the reason only `run.purchase` holders could see history at
 * all. Recover it from git if a "last run / month so far" summary is
 * ever wanted back on the run page.
 *
 * Detail reads use the store-trimmed `run.historyDetail` query. Money math
 * comes from ../lib/settlement (unit-tested); only super-admin correction
 * actions mutate a finished run.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Input, SectionLabel, Sheet, useToast } from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useUnitLabel } from '../../../hooks/useI18n';
import type { useI18n, useProductName } from '../../../hooks/useI18n';
import { splitSubtotal, settleItemLine, settlePerStore } from '../lib/settlement';

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

interface HistoryPagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function RunHistoryPage({
  runs,
  loading,
  fetching = false,
  totalCount,
  summaryTotal,
  pagination,
  toolbar,
  hasSearchOrFilters = false,
  onClearSearchOrFilters,
  storeById,
  skuById,
  productName,
  i18n,
  onBack,
}: {
  runs: RunListRow[];
  loading: boolean;
  fetching?: boolean;
  totalCount?: number;
  summaryTotal?: string;
  pagination?: HistoryPagination;
  toolbar?: ReactNode;
  hasSearchOrFilters?: boolean;
  onClearSearchOrFilters?: () => void;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  skuById: Map<
    string,
    {
      id: string;
      names: Record<string, string>;
      unit: string;
      step: string;
      categoryId?: string | null;
    }
  >;
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  /**
   * Omit when this renders as a top-level destination.
   *
   * 2026-07-30: history became its own bottom-nav tab, so the common
   * case has nothing to go back TO — a Back button there would either
   * dead-end or, worse, imply the tab is a drill-down off whatever the
   * user was looking at before. It stays optional rather than being
   * deleted because the component is still mounted as a drill page
   * elsewhere; when a caller passes it, the row renders as before.
   */
  onBack?: () => void;
}) {
  const [detailFor, setDetailFor] = useState<HistoryDetailTarget | null>(null);
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const total =
    summaryTotal ?? String(runs.reduce((sum, run) => sum + Number(run.actualTotal ?? 0), 0));
  const count = totalCount ?? runs.length;
  const firstResult =
    pagination && pagination.totalCount > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const lastResult = pagination
    ? Math.min(pagination.page * pagination.pageSize, pagination.totalCount)
    : count;

  return (
    <div className="flex flex-col gap-3 px-4 pb-24 pt-3">
      {/* The title row exists to host the Back button. As a tab there is
          no Back, and a lone <h1> reading "历史记录" directly above a card
          whose own header reads "历史记录  39 · 118,112,379.9 UZS" is the
          same word twice with the second one carrying all the
          information. Drop the row and let the card header BE the page
          heading (`as="h1"`), which is also how Order / Run already
          work — the bottom nav names the page, so an in-body title bar
          is redundant chrome. */}
      {onBack ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-[var(--r-pill)] px-2 py-1 text-label font-semibold text-[var(--c-action)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('common.back')}
          </button>
          <h1 className="text-h2 font-semibold text-[var(--c-fg)]">
            {i18n.t('run.history.title')}
          </h1>
        </div>
      ) : null}
      {toolbar}
      <Card className={fetching && !loading ? 'opacity-70 transition-opacity' : undefined}>
        <SectionLabel
          as={onBack ? undefined : 'h1'}
          meta={`${count} · ${formatMoney(total)} ${currency}`}
        >
          {i18n.t('run.history.title')}
        </SectionLabel>
        {loading ? (
          <div className="px-4 py-6 text-center text-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('common.loading')}
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-body-sm text-[var(--c-fg-muted)]">
            <span>
              {i18n.t(hasSearchOrFilters ? 'run.history.noMatches' : 'run.history.subtitle')}
            </span>
            {hasSearchOrFilters && onClearSearchOrFilters ? (
              <Button variant="secondary" size="sm" onClick={onClearSearchOrFilters}>
                {i18n.t('run.history.clearAll')}
              </Button>
            ) : null}
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
                  {/* UIUX-B1 (2026-07-06): constant success Badge with the
                      raw status enum deleted (list is finished-only — it
                      never varied, and leaked English; UI-2). The mono
                      total takes the freed right slot (L2 settlement row). */}
                  <div className="min-w-0 flex-1 text-body font-semibold tabular-nums">
                    {run.runDate}
                    {run.runIndex > 0 ? ` #${run.runIndex + 1}` : ''}
                  </div>
                  <span className="shrink-0 font-mono text-body tabular-nums">
                    {run.actualTotal ? formatMoney(run.actualTotal) : '—'}
                  </span>
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
      {pagination && pagination.totalCount > 0 ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="min-w-0 text-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.history.resultRange', {
              from: firstResult,
              to: lastResult,
              total: pagination.totalCount,
            })}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!pagination.hasPrevious || fetching}
              onClick={pagination.onPrevious}
            >
              {i18n.t('run.history.previousPage')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!pagination.hasNext || fetching}
              onClick={pagination.onNext}
            >
              {i18n.t('run.history.nextPage')}
            </Button>
          </div>
        </div>
      ) : null}
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
 * Fetches `run.historyDetail` lazily when opened. Shows:
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
    {
      id: string;
      names: Record<string, string>;
      unit: string;
      step: string;
      categoryId?: string | null;
    }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  onClose: () => void;
}) {
  // 2026-07-30 (flow review): history detail rows printed the raw canonical
  // unit ("kg") while the live run rows printed "公斤".
  const unitLabel = useUnitLabel();
  // M1.21: org-wide currency for the headline label.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  // 2026-07-06: super-admins (run.amend) may reopen a finished run to
  // correct it. The reopen moves it to `amending`; editing continues on
  // the 采购 (Run) tab, and the correction is closed with "完成修改" there.
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [reopenReason, setReopenReason] = useState('');
  const reopen = trpc.run.reopen.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      toast.success(i18n.t('run.amend.reopened'));
      setReopenReason('');
      onClose();
    },
    onError: errToast('common.error'),
  });

  /**
   * Purchase-date correction (2026-07-30).
   *
   * `runDate` is set once, when the run is CREATED, and nothing ever
   * changed it — so a run opened on the 23rd and closed on the 30th books
   * its whole spend under the 23rd. History groups and totals by this
   * field, so a wrong value quietly misattributes a day's (and a month's)
   * spend. This is the correction surface: past runs are exactly where
   * you notice the date is wrong.
   *
   * Unlike the reopen path below, this does NOT move the run to
   * `amending` — it touches no money, and refinalizing would rewrite the
   * frozen totals as a side effect of a pure calendar fix.
   */
  const [dateDraft, setDateDraft] = useState('');
  useEffect(() => {
    setDateDraft(target?.runDate ?? '');
  }, [target?.runDate, target?.runId]);
  const changeDate = trpc.run.changeDate.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.history.invalidate();
      void utils.run.get.invalidate();
      void utils.run.historyDetail.invalidate();
      toast.success(i18n.t('run.date.changed'));
      onClose();
    },
    onError: errToast('common.error'),
  });
  const detail = trpc.run.historyDetail.useQuery(target ? { runId: target.runId } : { runId: '' }, {
    enabled: !!target,
  });
  // The flat session permission list merges grants from every role scope.
  // Amendment authority is organization-wide and deny-sensitive, so only
  // trust the per-run answer derived from persisted bindings by the server.
  const canAmend = detail.data?.canAmend ?? false;
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
      const itemSplits = splits.filter((sp) => sp.skuId === it.skuId);
      if (
        it.status === 'purchased' &&
        it.purchasedQty &&
        (it.unitPrice || itemSplits.some((split) => split.unitPrice))
      ) {
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
    // 2026-07-26: shared with finishSummary's byStore in RunPage, which
    // held a verbatim copy of this loop. See runs/lib/settlement.ts.
    const perStore = settlePerStore(items, splits, expenses);
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
    activeStoreId && breakdown ? (breakdown.perStore.get(activeStoreId) ?? null) : null;

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
      return breakdown.items.map((item) => {
        const itemSplits = breakdown.splits.filter((split) => split.skuId === item.skuId);
        const hasVisiblePrice = Boolean(
          item.unitPrice || itemSplits.some((split) => split.unitPrice),
        );
        return {
          item,
          qty: item.purchasedQty,
          lineTotal:
            item.status === 'purchased' && item.purchasedQty && hasVisiblePrice
              ? itemSplits.reduce((sum, split) => sum + splitSubtotal(split, item), 0) ||
                Number(item.unitPrice) * Number(item.purchasedQty)
              : 0,
          perStoreSplits: itemSplits,
        };
      });
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
    : (breakdown?.purchasedCount ?? 0);
  const visibleUnavailableCount = activeStoreId
    ? visibleHistoryRows.filter((row) => row.item.status === 'unavailable').length
    : (breakdown?.unavailableCount ?? 0);
  const headlineTotal = activeStoreTotal?.total ?? breakdown?.total ?? 0;
  const headlineCash = activeStoreTotal?.cash ?? breakdown?.totalCash ?? 0;
  const headlineTransfer = activeStoreTotal?.transfer ?? breakdown?.totalTransfer ?? 0;
  const headlineStoreCount = activeStoreId ? 1 : (breakdown?.perStore.size ?? 0);
  const activeStoreName = activeStoreId
    ? (storeById.get(activeStoreId)?.name ?? activeStoreId.slice(0, 8))
    : null;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={
        target ? `${target.runDate}${target.runIndex > 0 ? ` #${target.runIndex + 1}` : ''}` : ''
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
                <SectionLabel padded={false}>{i18n.t('run.history.totalLabel')}</SectionLabel>
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
                <span className="text-[var(--c-fg-muted)]">{i18n.t('run.label.paymentCash')}</span>
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

          {/* 2026-07-30: purchase-date correction. Separate from the
              reopen block below on purpose — changing when a run is
              booked is not an edit to what was bought, so it neither
              needs nor triggers the amend cycle. */}
          {canAmend && target ? (
            <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3">
              <SectionLabel padded={false}>{i18n.t('run.date.label')}</SectionLabel>
              <p className="text-label text-[var(--c-fg-muted)]">{i18n.t('run.date.hint')}</p>
              <Input
                type="date"
                value={dateDraft}
                onChange={(e) => setDateDraft(e.target.value)}
                aria-label={i18n.t('run.date.label')}
              />
              <Button
                variant="pearl"
                loading={changeDate.isPending}
                disabled={!dateDraft || dateDraft === target.runDate}
                onClick={() => changeDate.mutate({ runId: target.runId, runDate: dateDraft })}
              >
                {i18n.t('run.date.change')}
              </Button>
            </div>
          ) : null}

          {/* 2026-07-06: super-admin correction entry. Reopens the
              finished run to `amending`; editing continues on the Run
              tab, closed there with "完成修改". Requires a reason (audit). */}
          {canAmend && target ? (
            <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-warn-bg)] px-4 py-3">
              <SectionLabel padded={false}>{i18n.t('run.amend.entryLabel')}</SectionLabel>
              <Input
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder={i18n.t('run.amend.reasonPlaceholder')}
                maxLength={500}
              />
              <Button
                variant="pearl"
                loading={reopen.isPending}
                disabled={reopenReason.trim().length === 0}
                onClick={() => reopen.mutate({ runId: target.runId, reason: reopenReason.trim() })}
              >
                {i18n.t('run.amend.reopenButton')}
              </Button>
            </div>
          ) : null}

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
                const displayedUnitPrice = activeStoreId
                  ? (perStoreSplits[0]?.unitPrice ?? it.unitPrice)
                  : it.unitPrice;
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
                        it.status === 'purchased' ? (
                          `${formatQty(row.qty)} ${unitLabel(sku?.unit)} × ${formatMoney(displayedUnitPrice)}`
                        ) : (
                          (it.unavailableNote ?? '')
                        )
                      ) : (
                        <>
                          {it.status === 'purchased'
                            ? `${formatQty(it.purchasedQty)} ${unitLabel(sku?.unit)}${it.unitPrice ? ` × ${formatMoney(it.unitPrice)}` : ''}`
                            : (it.unavailableNote ?? '')}
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
                              <span className="font-medium text-[var(--c-fg)]">{storeName}</span>
                              <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                                {formatQty(sp.qty)} {unitLabel(sku?.unit)}
                                {(sp.unitPrice ?? it.unitPrice)
                                  ? ` × ${formatMoney(sp.unitPrice ?? it.unitPrice)}`
                                  : ''}
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
                            <span>
                              {i18n.t('run.label.paymentCash')} {formatMoney(ps.cash)}
                            </span>
                            <span>
                              {i18n.t('run.label.paymentTransfer')} {formatMoney(ps.transfer)}
                            </span>
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
