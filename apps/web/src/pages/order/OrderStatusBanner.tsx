import { Banner, Button } from '@compass/ui';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { InRunBanner } from './InRunBanner';

/** What the banners read of a batch (order.todaySession's answer). */
export interface BannerBatch {
  id: string;
  status: string;
  runId: string | null;
  claimedByMemberId: string | null;
  claimedByDisplayName?: string | null;
  rejectReason: string | null;
  decidedAt: string | null;
  decidedByDisplayName?: string | null;
}

/**
 * Where one batch is, said once (review ORD-10, step 2). The order page
 * wrote this out three times — for the batch being edited, its own sent
 * batch and a batch opened from today's list — and the copies had
 * drifted: the opened batch's approved and in-run banners had no body,
 * and it called a batch a reviewer had picked up "submitted".
 *
 *  - rejected: the reviewer's reason, who sent it back and when. While
 *    the batch is being edited (`editing`) that is all; shown read-only
 *    (another draft is open), it says to finish that draft first.
 *  - picked up by a reviewer: who has it.
 *  - submitted: with 撤回 (`onWithdraw`) while nobody has picked it up.
 *    The server enforces the same rule; hiding it avoids a tap-then-403.
 *  - approved, in a run (InRunBanner), archived. A draft has none.
 */
export function OrderStatusBanner({
  batch,
  storeId,
  myMemberId,
  editing = false,
  onWithdraw,
  withdrawing = false,
}: {
  batch: BannerBatch;
  storeId: string;
  myMemberId: string;
  /** The batch is the one being edited (a rejected batch is fixed in place). */
  editing?: boolean;
  onWithdraw?: (sessionId: string) => void;
  withdrawing?: boolean;
}) {
  const i18n = useI18n();
  if (batch.status === 'rejected') {
    // DX-ORD-3 (2026-11-01): no 撤回 here. A rejected batch is edited in
    // place already; withdrawing it only turned it back into a draft and
    // took the reviewer's reason off the screen. The reason is the body
    // (it was the bold red title), with who sent it back and when.
    return editing ? (
      <Banner tone="danger" title={i18n.t('order.status.rejectedTitle')}>
        <RejectionDetails batch={batch} />
      </Banner>
    ) : (
      <Banner tone="warn" title={i18n.t('order.status.rejectedTitle')}>
        <RejectionDetails batch={batch} />
        <p className="mt-1">{i18n.t('order.batches.rejectedFinishDraft')}</p>
      </Banner>
    );
  }
  if (batch.status === 'draft') return null;
  if (batch.claimedByMemberId && batch.claimedByMemberId !== myMemberId) {
    return (
      <Banner
        tone="warn"
        title={i18n.t('order.banner.claimed', {
          who: batch.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
        })}
      />
    );
  }
  if (batch.status === 'submitted') {
    return (
      <Banner
        tone="info"
        title={i18n.t('order.status.submitted')}
        action={
          onWithdraw ? (
            <Button
              size="sm"
              variant="pearl"
              loading={withdrawing}
              onClick={() => onWithdraw(batch.id)}
            >
              {i18n.t('order.withdraw')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (batch.status === 'approved') {
    return (
      <Banner tone="success" title={i18n.t('order.banner.approved.title')}>
        {i18n.t('order.banner.approved.body')}
      </Banner>
    );
  }
  if (batch.status === 'in_run') {
    return <InRunBanner runId={batch.runId} storeId={storeId} />;
  }
  return <Banner tone="info" title={i18n.t('order.status.archived')} />;
}

/** DX-ORD-3: the reviewer's reason, then who rejected it and when. */
function RejectionDetails({ batch }: { batch: BannerBatch }) {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const who = batch.decidedByDisplayName || i18n.t('approval.unknownReviewer');
  return (
    <>
      <p className="whitespace-pre-line">
        {batch.rejectReason || i18n.t('order.status.rejectedNoReason')}
      </p>
      {batch.decidedAt ? (
        <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('order.status.rejectedBy', { who, time: dateFmt.time(batch.decidedAt) })}
        </p>
      ) : null}
    </>
  );
}

/** ORD-4: a batch sent back by a reviewer, said on every view. */
export function RejectedBatchNotice({
  batch,
  onOpen,
}: {
  batch: { id: string; batchNumber: number; rejectReason: string | null };
  onOpen: (id: string) => void;
}) {
  const i18n = useI18n();
  return (
    <Banner
      tone="warn"
      title={i18n.t('order.batches.rejectedTitle', { n: batch.batchNumber })}
      action={
        <Button size="sm" variant="pearl" onClick={() => onOpen(batch.id)}>
          {i18n.t('order.batches.open')}
        </Button>
      }
    >
      {batch.rejectReason || i18n.t('order.status.rejectedNoReason')}
    </Banner>
  );
}
