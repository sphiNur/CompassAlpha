/**
 * Owner 2026-11-23: the store's receiving record, under the receiving
 * list. What the store received in the last two weeks (run.storeReceipts,
 * RECEIPT_DAYS), one card per run: whether everything was as expected or
 * how many lines had a problem, who confirmed, and, opened, every line
 * with its verdict, what arrived, the note and the photo. A line whose
 * purchase was revised after the store confirmed it says so; the quantity
 * shown is the revised one.
 *
 * No money: the query returns none, so store staff (who may not see
 * prices) get the record too.
 *
 * Open when there is nothing to check; folded under the list when there
 * is, so the record never stands between the receiver and today's goods.
 */
import { useState } from 'react';
import { Card, NameCell, SkeletonList } from '@compass/ui';
import { PhotoThumb, PhotoViewerSheet, type ViewedPhoto } from '../../components/PhotoThumb';
import { useDateFormat, useI18n, useProductNameParts, useUnitLabel } from '../../hooks/useI18n';
import { formatQty } from '../../lib/format';
import { rowName } from '../../lib/productName';
import { confirmStatusLabel } from '../../lib/statusLabels/delivery';
import { trpc, type RouterOutputs } from '../../lib/trpc';

type Receipt = RouterOutputs['run']['storeReceipts'][number];
type SkuLook = { names: Record<string, string>; unit: string };

/** Lines that are not simply "as expected". */
export function problemLines<L extends { verdict: string | null }>(lines: readonly L[]): L[] {
  return lines.filter((l) => l.verdict !== null && l.verdict !== 'ok');
}

export function ReceivingRecord({
  storeId,
  skuById,
  folded,
}: {
  storeId: string;
  skuById: ReadonlyMap<string, SkuLook>;
  /** There is a list to check above: start folded. */
  folded: boolean;
}) {
  const i18n = useI18n();
  const query = trpc.run.storeReceipts.useQuery(
    { storeId },
    // An older server without the record: no section, no retries.
    { retry: false },
  );
  const [photo, setPhoto] = useState<ViewedPhoto | null>(null);
  if (query.isError) return null;
  const body = query.isPending ? (
    <SkeletonList count={2} />
  ) : query.data.length === 0 ? (
    <p className="text-old-label text-[var(--c-fg-muted)]">{i18n.t('confirm.records.empty')}</p>
  ) : (
    <ul role="list" className="flex flex-col gap-2">
      {query.data.map((r) => (
        <li key={r.runId}>
          <ReceiptCard receipt={r} skuById={skuById} onPhoto={setPhoto} />
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-labelledby="receiving-record-title" data-testid="receiving-record">
      <details open={!folded} className="group flex flex-col gap-2">
        <summary className="press flex min-h-11 cursor-pointer list-none flex-col gap-0.5 py-1">
          <h2
            id="receiving-record-title"
            className="text-old-body font-semibold text-[var(--c-fg)]"
          >
            {folded ? i18n.t('confirm.records.show') : i18n.t('confirm.records.title')}
          </h2>
          <span className="text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('confirm.records.hint')}
          </span>
        </summary>
        <div className="pt-2">{body}</div>
      </details>
      <PhotoViewerSheet photo={photo} onClose={() => setPhoto(null)} />
    </section>
  );
}

function ReceiptCard({
  receipt,
  skuById,
  onPhoto,
}: {
  receipt: Receipt;
  skuById: ReadonlyMap<string, SkuLook>;
  onPhoto: (photo: ViewedPhoto) => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const problems = problemLines(receipt.lines).length;
  const revised = receipt.lines.some((l) => l.revisedAt !== null);
  return (
    <Card>
      <details data-testid={`receipt-${receipt.runId}`}>
        <summary className="press flex min-h-11 cursor-pointer list-none flex-col gap-0.5 px-4 py-3">
          <span className="flex items-center justify-between gap-3">
            <span className="text-old-body font-semibold tabular-nums text-[var(--c-fg)]">
              {i18n.t('confirm.records.run', {
                date: dates.calendarDay(receipt.runDate),
                n: receipt.runIndex + 1,
              })}
            </span>
            <span
              className={
                'shrink-0 text-old-label font-semibold ' +
                (problems > 0 ? 'text-[var(--c-warning-fg)]' : 'text-[var(--c-success)]')
              }
            >
              {problems > 0
                ? i18n.t('confirm.records.problems', { n: problems })
                : i18n.t('confirm.records.allOk')}
            </span>
          </span>
          <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {[
              receipt.confirmedBy
                ? i18n.t('confirm.records.confirmedBy', { name: receipt.confirmedBy })
                : null,
              dates.dateTime(receipt.confirmedAt),
              revised ? i18n.t('confirm.records.revised') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </summary>
        <ul role="list" className="flex flex-col border-t border-[var(--c-divider)]">
          {receipt.lines.map((line) => (
            <ReceiptLineRow
              key={line.skuId}
              line={line}
              sku={skuById.get(line.skuId)}
              onPhoto={onPhoto}
            />
          ))}
        </ul>
      </details>
    </Card>
  );
}

function ReceiptLineRow({
  line,
  sku,
  onPhoto,
}: {
  line: Receipt['lines'][number];
  sku: SkuLook | undefined;
  onPhoto: (photo: ViewedPhoto) => void;
}) {
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
  const unitLabel = useUnitLabel();
  const name = rowName(productNameParts, sku, i18n.t('common.unknownProduct'));
  const problem = line.verdict !== null && line.verdict !== 'ok';
  return (
    <li className="flex flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <NameCell {...name} size="default" />
        <span className="shrink-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
          {formatQty(line.qty)} {unitLabel(sku?.unit, line.qty)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-old-label">
        <span
          className={
            'font-semibold ' + (problem ? 'text-[var(--c-warning-fg)]' : 'text-[var(--c-fg-muted)]')
          }
        >
          {confirmStatusLabel(i18n, line.verdict)}
        </span>
        {problem && line.receivedQty !== null ? (
          <span className="tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('confirm.records.received', {
              qty: `${formatQty(line.receivedQty)} ${unitLabel(sku?.unit, line.receivedQty)}`,
            })}
          </span>
        ) : null}
        {line.revisedAt ? (
          <span className="text-[var(--c-fg-muted)]">{i18n.t('confirm.records.revised')}</span>
        ) : null}
      </div>
      {line.note ? <p className="text-old-label text-[var(--c-fg)]">{line.note}</p> : null}
      {line.photoUrl ? (
        <PhotoThumb
          url={line.photoUrl}
          label={i18n.t('confirm.records.photo', { name: name.primary ?? '' })}
          onOpen={onPhoto}
        />
      ) : null}
    </li>
  );
}
