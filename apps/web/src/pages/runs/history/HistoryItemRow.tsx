/**
 * One line of a finished run's history detail: what was bought (or that
 * it was not available) and how it was paid, what the stores reported on
 * receipt, who sold it and the receipt, what changed after receipt, and
 * the split across stores.
 */
import { Badge, NameCell } from '@compass/ui';
import { PhotoThumb, type ViewedPhoto } from '../../../components/PhotoThumb';
import { useI18n, useProductNameParts, useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import { rowName } from '../../../lib/productName';
import { confirmStatusLabel } from '../../../lib/statusLabels/delivery';
import {
  linePaymentOf,
  type HistoryCorrection,
  type HistorySplit,
  type VisibleHistoryRow,
} from '../lib/historyBreakdown';
import { amendAddedFor, receivedTotal } from '../lib/receivedLine';
import type { SkuLite, StoreLite } from '../types';

export function HistoryItemRow({
  row,
  sku,
  storeId,
  multiStore,
  corrections,
  storeById,
  supplierName,
  onOpenPhoto,
}: {
  row: VisibleHistoryRow;
  sku: SkuLite | undefined;
  /** The store the sheet shows; null for the whole run. */
  storeId: string | null;
  /** The whole run of several stores: the line shows its split. */
  multiStore: boolean;
  corrections: readonly HistoryCorrection[];
  storeById: Map<string, StoreLite>;
  /** Who it was bought from, when known. */
  supplierName: string | null;
  onOpenPhoto: (photo: ViewedPhoto) => void;
}) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): history detail rows printed the raw canonical
  // unit ("kg") while the live run rows printed "公斤".
  const unitLabel = useUnitLabel();
  const productNameParts = useProductNameParts();
  const it = row.item;
  const nm = rowName(productNameParts, sku, i18n.t('common.unknownProduct'));
  const lineTotal = row.lineTotal;
  const perStoreSplits = row.perStoreSplits;
  const displayedUnitPrice = storeId
    ? (perStoreSplits[0]?.unitPrice ?? it.unitPrice)
    : it.unitPrice;
  const storeName = (id: string) => storeById.get(id)?.name ?? i18n.t('common.unknownStore');
  // DX-DLV-01: on a problem line a store reported, a correction's added
  // quantity joins that store's receiving line (in every view, DX-DLV-03)
  // instead of a second line.
  const amendFor = (sp: HistorySplit) =>
    sp.confirmStatus && sp.confirmStatus !== 'ok' && sp.confirmReceivedQty != null
      ? amendAddedFor(corrections, it.skuId, sp.storeId)
      : null;
  const mergedAmendStores = new Set(
    perStoreSplits.filter((sp) => amendFor(sp)).map((sp) => sp.storeId),
  );
  // 2026-10-11: how each line was paid. A line paid both ways says how
  // much of each.
  const payment = linePaymentOf(it, perStoreSplits, !!storeId);
  return (
    <li className="border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        {/* UI-4 (review RUNWEB2-06): two lines, not truncated. */}
        <NameCell {...nm} />
        {it.status === 'purchased' ? (
          <span className="text-old-body font-semibold tabular-nums">
            {lineTotal !== null ? formatMoney(lineTotal) : '—'}
          </span>
        ) : (
          <Badge tone="danger">{i18n.t('run.action.markNa')}</Badge>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
        <span className="min-w-0">
          {storeId ? (
            it.status === 'purchased' ? (
              `${formatQty(row.qty)} ${unitLabel(sku?.unit, row.qty)} × ${formatMoney(displayedUnitPrice)}`
            ) : (
              (it.unavailableNote ?? '')
            )
          ) : (
            <>
              {it.status === 'purchased'
                ? `${formatQty(it.purchasedQty)} ${unitLabel(sku?.unit, it.purchasedQty)}${it.unitPrice ? ` × ${formatMoney(it.unitPrice)}` : ''}`
                : (it.unavailableNote ?? '')}
            </>
          )}
        </span>
        {it.status === 'purchased' ? (
          <span
            data-testid="history-line-payment"
            className="shrink-0 font-medium text-[var(--c-fg)]"
          >
            {payment === 'both'
              ? i18n.t('run.money.cashTransfer', {
                  cash: formatMoney(it.cashAmount ?? '0'),
                  transfer: formatMoney(it.transferAmount ?? '0'),
                })
              : i18n.t(
                  payment === 'transfer' ? 'run.label.paymentTransfer' : 'run.label.paymentCash',
                )}
          </span>
        ) : null}
      </div>
      {/* 2026-10-21 CA-06: the store's receiving verdict on a problem
          line, with what it actually received. DX-DLV-03 (2026-11-01):
          also in 「全部门店」, one line per store with a problem, named —
          the combined view showed none, so a run read as received in full. */}
      {perStoreSplits
        .filter((sp) => sp.confirmStatus && sp.confirmStatus !== 'ok')
        .map((sp) => (
          <div
            key={`issue-${sp.storeId}`}
            data-testid="history-receiving-issue"
            className="mt-1 text-old-label font-medium tabular-nums text-[var(--c-warning-fg)]"
          >
            {storeId ? '' : `${storeName(sp.storeId)} · `}
            {confirmStatusLabel(i18n, sp.confirmStatus)}
            {sp.confirmReceivedQty != null
              ? ' · ' +
                (amendFor(sp)
                  ? // DX-DLV-01: the quantity a correction added counts as
                    // received; one line says both.
                    i18n.t('confirm.receivedPlusAmend', {
                      received: formatQty(sp.confirmReceivedQty),
                      added: formatQty(amendFor(sp)!),
                      total: formatQty(receivedTotal(sp.confirmReceivedQty, amendFor(sp)!)),
                      qty: formatQty(sp.qty),
                      unit: unitLabel(sku?.unit, sp.qty),
                    })
                  : i18n.t('confirm.receivedOf', {
                      received: formatQty(sp.confirmReceivedQty),
                      qty: formatQty(sp.qty),
                      unit: unitLabel(sku?.unit, sp.qty),
                    }))
              : ''}
            {sp.confirmNote ? ` · ${sp.confirmNote}` : ''}
          </div>
        ))}
      {/* DX-HIS-6 (2026-11-01): who it was bought from and the receipt
          photo, both recorded at purchase and never shown here. */}
      {it.status === 'purchased' && (supplierName || it.receiptPhotoUrl) ? (
        <div className="mt-1 flex items-center gap-2 text-old-label text-[var(--c-fg-muted)]">
          {supplierName ? (
            <span data-testid="history-line-supplier" className="min-w-0 truncate">
              {i18n.t('run.history.supplier', { name: supplierName })}
            </span>
          ) : null}
          {it.receiptPhotoUrl ? (
            <PhotoThumb
              url={it.receiptPhotoUrl}
              label={i18n.t('run.history.receiptOf', { item: nm.primary })}
              onOpen={onOpenPhoto}
            />
          ) : null}
        </div>
      ) : null}
      {/* D3 / D4 (2026-10-31): what changed on this line after a store
          confirmed receipt — quantity a correction added (counted as
          received) and later price changes. */}
      {corrections
        .filter(
          (c) =>
            c.skuId === it.skuId &&
            (!storeId || c.storeId === null || c.storeId === storeId) &&
            !(c.kind === 'amendAdded' && mergedAmendStores.has(c.storeId)),
        )
        .map((c, i) => (
          <div
            key={`${c.kind}-${i}`}
            data-testid="history-correction"
            className="mt-1 text-old-label font-medium tabular-nums text-[var(--c-fg-muted)]"
          >
            {c.kind === 'amendAdded'
              ? i18n.t('run.history.amendAdded', {
                  qty: formatQty(c.qty),
                  unit: unitLabel(sku?.unit, c.qty),
                  store: storeName(c.storeId),
                })
              : i18n.t('run.history.priceAfterReceipt', {
                  from: c.from ? formatMoney(c.from) : '—',
                  to: formatMoney(c.to),
                }) + (c.reason ? ` · ${c.reason}` : '')}
          </div>
        ))}
      {/* M3.52: per-store chips on history rows. Same visual pattern as
          the in-run PurchaseRow chips. */}
      {multiStore && it.status === 'purchased' && perStoreSplits.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {perStoreSplits.map((sp) => (
            <span
              key={sp.storeId}
              className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-bg)] px-1.5 py-0.5 text-old-label ring-1 ring-[var(--c-divider)]"
            >
              <span className="font-medium text-[var(--c-fg)]">{storeName(sp.storeId)}</span>
              <span className="tabular-nums text-[var(--c-fg-muted)]">
                {formatQty(sp.qty)} {unitLabel(sku?.unit, sp.qty)}
                {(sp.unitPrice ?? it.unitPrice)
                  ? ` × ${formatMoney(sp.unitPrice ?? it.unitPrice)}`
                  : ''}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}
