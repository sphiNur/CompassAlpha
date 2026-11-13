import type { ReactNode } from 'react';
import { Button, SectionLabel, StickyPageBar } from '@compass/ui';
import { useI18n, useProductName } from '../../hooks/useI18n';
import { useCurrency } from '../../hooks/useCurrency';
import { BatchStrip } from './BatchStrip';
import { ReceiptList } from './ReceiptList';
import { SessionExtrasEditor } from './SessionExtrasEditor';
import { OrderStatusBanner, RejectedBatchNotice, type BannerBatch } from './OrderStatusBanner';
import { otherRejectedBatch } from './batchStatus';
import type { ExtraDraft } from './extraRows';
import type { ReviewTotal } from './ReviewList';

const NO_TOTALS: ReviewTotal[] = [];
const NO_EXTRAS: ExtraDraft[] = [];

/**
 * A sent batch's receipt (2026-07-30).
 *
 * Before this, submitting left you on the same 244-row catalog with every
 * row disabled — ~12,000 px of greyed-out list — and the review sheet's
 * only entry point was the main button, which hides itself once
 * `canSubmit` goes false. So after pressing Submit there was literally no
 * way to see what you had just sent.
 *
 * The catalog is a tool for *choosing*; once the choice is made it's
 * noise. This replaces it with the receipt: what you sent, what it's
 * worth, where it is in the pipeline, and the two things you might now
 * want — take it back, or start another batch.
 *
 * Review ORD-10 (2026-11, step 2): one receipt for the page's own sent
 * batch and for a batch opened from today's list (ORD-4), which had a
 * copy of its own. They differ only where the view does: the opened batch
 * has a way back (`onBack`), the page's own the next batch
 * (`onNewBatch`).
 */
export function BatchReceipt({
  batch,
  batches,
  storeId,
  myMemberId,
  dateLabel,
  skus,
  categories,
  onSelectBatch,
  onWithdraw,
  withdrawing,
  onBack,
  onNewBatch,
  staleWarning,
}: {
  batch: BannerBatch & { totals?: ReviewTotal[]; extras?: ExtraDraft[] };
  /** Today's batches (order.todayBatches). */
  batches: Array<
    Parameters<typeof BatchStrip>[0]['batches'][number] & { rejectReason: string | null }
  >;
  storeId: string;
  myMemberId: string;
  dateLabel: string;
  skus: Parameters<typeof ReceiptList>[0]['skus'];
  categories: Parameters<typeof ReceiptList>[0]['categories'];
  onSelectBatch: (id: string) => void;
  onWithdraw: (sessionId: string) => void;
  withdrawing: boolean;
  /** A batch opened from today's list: "‹ Back to the current batch". */
  onBack?: () => void;
  /** The page's own sent batch: "Place another order". */
  onNewBatch?: () => void;
  /** The page's batch failed to refresh (shown under the sticky strip). */
  staleWarning?: ReactNode;
}) {
  const i18n = useI18n();
  const productName = useProductName();
  const currency = useCurrency();
  const totals = batch.totals ?? NO_TOTALS;
  const extras = batch.extras ?? NO_EXTRAS;
  const rejected = otherRejectedBatch(batches, batch.id);
  return (
    <div className="flex flex-col pb-4">
      {/* min-h-12 py-1 (RE-VIS-3 / R2-VIS-2, 2026-10-31): the strip is
          taller than the back button's 44px tap area plus its 1px border.
          In the default 30px strip the area stuck out of the top edge,
          under the header. Store moved to Shell's top strip (2026-07-30) —
          the date is the only page-specific thing this strip carries. */}
      <StickyPageBar className={onBack ? 'min-h-12 py-1' : undefined}>
        {onBack ? (
          // Review ORD-22 (2026-11): the kit's Button, not a hand-made link (UI-16).
          <Button size="sm" variant="ghost" className="-ml-3 font-semibold" onClick={onBack}>
            <span aria-hidden>‹</span> {i18n.t('order.batches.backToCurrent')}
          </Button>
        ) : null}
        <span className="ml-auto shrink-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
          {dateLabel}
        </span>
      </StickyPageBar>
      {staleWarning}

      <div className="flex flex-col gap-3 px-4 pt-3">
        {/* 2026-10-21 audit CA-44: one BatchStrip, above the banner. */}
        <BatchStrip
          batches={batches}
          currentId={batch.id}
          i18n={i18n}
          currency={currency}
          onSelect={onSelectBatch}
        />
        {rejected ? <RejectedBatchNotice batch={rejected} onOpen={onSelectBatch} /> : null}
        <OrderStatusBanner
          batch={batch}
          storeId={storeId}
          myMemberId={myMemberId}
          onWithdraw={onWithdraw}
          withdrawing={withdrawing}
        />
        {/* ORD-13 (2026-10-30): an extras-only batch said "nothing chosen
            yet"; its extras are listed below. */}
        {totals.length > 0 || extras.length === 0 ? (
          <div>
            <SectionLabel padded={false} className="mb-1.5">
              {i18n.t('order.receipt.submittedItems')}
            </SectionLabel>
            <ReceiptList
              sessionId={batch.id}
              status={batch.status}
              totals={totals}
              extras={extras}
              skus={skus}
              categories={categories}
              productName={productName}
            />
          </div>
        ) : null}
      </div>

      {/* Extras render read-only through the same editor the draft uses,
          so an off-catalog request the store made still shows up on the
          receipt instead of silently disappearing after submit.
          CMP-ORD-2 (2026-10-31): a batch opened from today's list shows
          them too. `key` gives each batch its own editor. */}
      {batch.id !== 'optimistic' ? (
        <SessionExtrasEditor
          key={batch.id}
          sessionId={batch.id}
          storeId={storeId}
          initialValue={extras}
          isReadOnly
          onSave={async () => {
            /* read-only — never called */
          }}
        />
      ) : null}

      {onNewBatch ? (
        <div className="px-4 pt-4">
          <Button block size="lg" variant="pearl" onClick={onNewBatch}>
            {i18n.t('order.batches.newBatch')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
