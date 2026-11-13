/**
 * Drill-down sheet for one historical run.
 *
 * Fetches `run.historyDetail` lazily when opened. Shows:
 *   - Status + total + finished-at timestamp at the top
 *   - Per-item rows: name, qty bought, unit price, line total, supplier
 *   - Per-store breakdown: items received, store-level subtotal
 *
 * Receipt photos show as thumbnails; tapping one opens it large in a
 * sheet (DX-HIS-6). The figures come from runs/lib/historyBreakdown.ts
 * (review RUNWEB2-09); only super-admin correction actions mutate a
 * finished run (RunCorrectionForms).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Chip,
  ChipBar,
  EmptyState,
  LoadingState,
  OfflineState,
  QueryErrorBanner,
  SectionLabel,
  Sheet,
  surfaceClass,
} from '@compass/ui';
import { PhotoViewerSheet, type ViewedPhoto } from '../../../components/PhotoThumb';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';
import { runStatusLabel } from '../../../lib/statusLabels/run';
import { trpc } from '../../../lib/trpc';
import { useHistoryBreakdown } from '../hooks/useHistoryBreakdown';
import type { SkuLite, StoreLite } from '../types';
import type { HistoryDetailTarget } from './detailTarget';
import { HistoryExpenseList } from './HistoryExpenseList';
import { HistoryItemRow } from './HistoryItemRow';
import { MoneySummaryPanel } from './MoneySummaryPanel';
import { RunCorrectionForms } from './RunCorrectionForms';
import { StoreSettlementList } from './StoreSettlementList';

export function RunHistoryDetailSheet({
  target,
  skuById,
  storeById,
  onClose,
}: {
  target: HistoryDetailTarget | null;
  skuById: Map<string, SkuLite>;
  storeById: Map<string, StoreLite>;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const detail = trpc.run.historyDetail.useQuery(target ? { runId: target.runId } : { runId: '' }, {
    enabled: !!target,
  });
  // The flat session permission list merges grants from every role scope.
  // Amendment authority is organization-wide and deny-sensitive, so only
  // trust the per-run answer derived from persisted bindings by the server.
  const canAmend = detail.data?.canAmend ?? false;
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [photoFor, setPhotoFor] = useState<ViewedPhoto | null>(null);
  const supplierName = (id: string | null | undefined): string | null =>
    id ? (detail.data?.supplierNameById?.[id] ?? null) : null;

  useEffect(() => {
    setSelectedStoreId(target?.initialStoreId ?? null);
  }, [target?.initialStoreId, target?.runId]);

  const { breakdown, activeStoreId, rows, headline } = useHistoryBreakdown(
    detail.data,
    selectedStoreId,
  );
  const storeOptions = useMemo(
    () => (breakdown ? [...breakdown.perStore.values()] : []),
    [breakdown],
  );
  const activeStoreName = activeStoreId
    ? (storeById.get(activeStoreId)?.name ?? i18n.t('common.unknownStore'))
    : null;
  const corrections = detail.data?.corrections ?? [];

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={
        !target
          ? ''
          : target.runIndex > 0
            ? i18n.t('run.history.runTitle', {
                date: dates.calendarDay(target.runDate),
                n: target.runIndex + 1,
              })
            : dates.calendarDay(target.runDate)
      }
      // DLV-16 (2026-10-30): was the raw status ("finished", "amending").
      description={target?.status ? runStatusLabel(i18n, target.status) : undefined}
    >
      {!target ? null : detail.isLoading ? (
        <LoadingState />
      ) : detail.isError && !breakdown ? (
        // F11 (2026-10-30): a failed load said "no data", so nobody retried.
        // RUNWEB2-21: the kit's banner, with the translated reason.
        <QueryErrorBanner query={detail} />
      ) : !breakdown && detail.fetchStatus === 'paused' ? (
        // HIS-18 (2026-10-31): offline, a detail never opened before waits
        // for the network; it is not "no data" and loads once back online.
        <OfflineState />
      ) : !breakdown || !headline ? (
        <EmptyState title={i18n.t('run.history.noDetail')} />
      ) : (
        <div className="flex flex-col gap-4 py-3">
          {/* Top summary */}
          <MoneySummaryPanel
            total={headline.total}
            itemsTotal={headline.itemsTotal}
            expensesTotal={headline.expensesTotal}
            cash={headline.cash}
            transfer={headline.transfer}
            aside={
              <div className="text-right text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('run.history.itemSummary', {
                  bought: headline.purchasedCount,
                  na: headline.unavailableCount,
                })}
                <br />
                {i18n.t('run.history.storeSummary', { stores: headline.storeCount })}
              </div>
            }
          >
            {/* DX-DLV-03 (2026-11-01): problems the stores reported on
                receipt, counted up front in every view. */}
            {headline.receivingIssueCount > 0 ? (
              <div
                data-testid="history-issue-summary"
                className="text-old-label font-medium text-[var(--c-warning-fg)]"
              >
                {i18n.t('run.history.receivingIssues', { n: headline.receivingIssueCount })}
              </div>
            ) : null}
          </MoneySummaryPanel>

          {storeOptions.length > 1 ? (
            // R2-HIS-5 (2026-10-31): the segments are 36px (min-h-9) in a
            // 44px strip. overflow-x-auto clips anything outside the strip,
            // so a segment's hit-44 only works if the strip is 44 tall; at
            // 26px segments the area was cut to 36.
            <ChipBar
              variant="radio"
              // RUNWEB2-32: the group's name, not its first option's.
              ariaLabel={i18n.t('run.history.storeFilter')}
            >
              <Chip selected={!activeStoreId} onClick={() => setSelectedStoreId(null)}>
                {i18n.t('run.history.allStores')}
              </Chip>
              {storeOptions.map((storeTotal) => {
                const storeName =
                  storeById.get(storeTotal.storeId)?.name ?? i18n.t('common.unknownStore');
                return (
                  <Chip
                    key={storeTotal.storeId}
                    selected={activeStoreId === storeTotal.storeId}
                    onClick={() => setSelectedStoreId(storeTotal.storeId)}
                  >
                    <span className="inline-block max-w-[9rem] truncate align-bottom">
                      {storeName}
                    </span>
                  </Chip>
                );
              })}
            </ChipBar>
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
            <ul className={`flex flex-col ${surfaceClass}`}>
              {rows.length === 0 ? (
                <li className="px-4 py-3 text-center text-old-label text-[var(--c-fg-muted)]">
                  {activeStoreName
                    ? i18n.t('run.history.noStoreItems')
                    : i18n.t('run.history.noDetail')}
                </li>
              ) : null}
              {rows.map((row) => (
                <HistoryItemRow
                  key={row.item.skuId}
                  row={row}
                  sku={skuById.get(row.item.skuId)}
                  storeId={activeStoreId}
                  multiStore={!activeStoreId && breakdown.perStore.size > 1}
                  corrections={corrections}
                  storeById={storeById}
                  supplierName={supplierName(row.item.supplierId)}
                  onOpenPhoto={setPhotoFor}
                />
              ))}
            </ul>
          </div>

          {breakdown.perStore.size > 0 ? (
            <StoreSettlementList
              stores={storeOptions.filter((ps) => !activeStoreId || ps.storeId === activeStoreId)}
              storeById={storeById}
            />
          ) : null}

          {breakdown.expenses.length > 0 ? (
            <HistoryExpenseList
              expenses={breakdown.expenses.filter(
                (ex) => !activeStoreId || ex.storeSplits.some((sp) => sp.storeId === activeStoreId),
              )}
              onOpenPhoto={setPhotoFor}
            />
          ) : null}

          {canAmend ? <RunCorrectionForms target={target} onClose={onClose} /> : null}
        </div>
      )}
      <PhotoViewerSheet photo={photoFor} onClose={() => setPhotoFor(null)} />
    </Sheet>
  );
}
