import { Avatar, Badge, Banner, Button, Card, CardHeader, CardMeta, CardTitle } from '@compass/ui';
import type { RouterOutputs } from '../../lib/trpc';
import type { AuthSession } from '../../stores/authStore';
import { useDateFormat, useI18n, useProductName } from '../../hooks/useI18n';
import { useCurrency } from '../../hooks/useCurrency';
import { confirmThen } from '../../lib/confirm';
import { formatMoney } from '../../lib/format';
import { hasStorePermission } from '../../lib/storePermission';
import { cardRequests, showPaymentSplit } from './cardSummary';
import { approvable } from './reviewDiff';
import { SessionItems } from './SessionItems';

export type ApprovalTab = 'pending' | 'approved' | 'rejected';

/** Which of a card's writes is on its way (each shows its own spinner). */
export interface ApprovalCardBusy {
  approving: boolean;
  takingOver: boolean;
  releasing: boolean;
  unapproving: boolean;
}

/**
 * One order in the approval queue (review ORD-10, step 2: moved out of
 * ApprovalPage as it was). The page keeps the writes and what follows
 * them; the card says who sent what, where it is, and offers what this
 * reviewer may do with it now.
 */
export function ApprovalCard({
  row,
  session,
  tab,
  storeScoped,
  showSubmitTime,
  online,
  adjusting,
  held,
  open,
  busy,
  skuById,
  onHold,
  onApprove,
  onReject,
  onRelease,
  onTakeOver,
  onUnapprove,
  onToggleItems,
}: {
  row: RouterOutputs['order']['pendingList'][number];
  session: AuthSession;
  tab: ApprovalTab;
  /** The queue is one store's: the store chip names it already. */
  storeScoped: boolean;
  /** APR-15: another card from the same person on the same day. */
  showSubmitTime: boolean;
  online: boolean;
  /** DX-APR-1: a quantity change of this order is still on its way. */
  adjusting: boolean;
  /** DX-APR-2 / DX-APR-3: its 「通过」 waits (unsaved or unseen changes). */
  held: boolean;
  /** Its lines are shown. */
  open: boolean;
  busy: ApprovalCardBusy;
  skuById: Parameters<typeof SessionItems>[0]['skuById'];
  onHold: (sessionId: string, hold: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
  onRelease: () => void;
  /** Asked to confirm first. */
  onTakeOver: () => void;
  /** Asked to confirm first. */
  onUnapprove: () => void;
  onToggleItems: () => void;
}) {
  const i18n = useI18n();
  const productName = useProductName();
  const dates = useDateFormat();
  // ORD-21 (2026-11): the card's total names the currency, as the
  // estimate in its detail does.
  const currency = useCurrency();
  const isClaimedByMe = row.claimedByMemberId === session.member.memberId;
  const isClaimedByOther =
    row.claimedByMemberId && row.claimedByMemberId !== session.member.memberId;
  const requests = cardRequests(row.notes, row.extrasJson);
  const canApproveRow = approvable(row.itemCount, requests.extras);
  return (
    <Card as="li">
      {/* A11Y-1 (2026-10-31): the amounts move under the name when
        the card is too narrow (200% zoom) instead of running
        off its edge. */}
      <CardHeader className="flex-wrap">
        <div className="flex min-w-[8rem] flex-1 items-center gap-3">
          {/* The avatar is the SUBMITTER's photo (`attribAvatarUrl`),
            so `name` — which supplies the initials fallback —
            has to be the submitter too. (Since UI-24 the
            avatar has no alt text: the name is on the card.)
            2026-07-30: it was the STORE name, so a screen reader
            announced a person's face as "Store A", and a
            submitter without a photo got the store's initials. */}
          <Avatar src={row.attribAvatarUrl} name={row.attribDisplayName ?? '?'} size={32} />
          <div className="min-w-0">
            {/*
            Which name is the headline depends on what the page
            has ALREADY told you (2026-07-30).

            Filtered to one store, the store chip in the sticky
            bar names it once — repeating it on every card spent
            the title line restating context and pushed the one
            thing that differs between cards, WHO submitted,
            down into the muted meta. Scoped to one store the
            submitter is the headline; on 所有门店 the store is,
            because that's what distinguishes the rows.
          */}
            <CardTitle as="h2">
              {storeScoped
                ? (row.attribDisplayName ?? i18n.t('common.unknownMember'))
                : row.storeName?.trim() || i18n.t('common.unknownStore')}
            </CardTitle>
            <CardMeta>
              {/* M1.9-fix (2026-05-07): all 3 segments and the
                timestamp locale were hardcoded; non-English
                users saw English meta on every card. */}
              {storeScoped
                ? null
                : row.attribDisplayName
                  ? i18n.t('approval.submittedBy', { name: row.attribDisplayName }) + ' · '
                  : '— · '}
              {row.contributorCount > 1
                ? i18n.t('approval.contributorsCount', { n: row.contributorCount }) + ' · '
                : ''}
              {/* D16: in the UI language, not "2026-10-31". */}
              {dates.calendarDay(row.orderDate)}
              {/* APR-15 (2026-10-30): two cards from one person on
                one day were indistinguishable; only then the
                submit time tells them apart. */}
              {row.submittedAt && showSubmitTime ? ' · ' + dates.time(row.submittedAt) : ''}
              {/* UI-3 (declutter): dropped the standalone HH:MM
                time — it wrapped the meta to a second line and
                the exact timestamp lives in the detail view. */}
            </CardMeta>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
          {/* M1.11 cleanup (2026-05-08) dropped the
            "{itemCount} · {totalQty}" Badge, reasoning that
            "the View items expansion + the inline estimate
            row already surface count + total".

            2026-07-30 (flow review): that reasoning is
            inverted — triage happens BEFORE expanding. With
            nothing on the card, an approver had to open every
            single one to find out whether it was a 1-line
            top-up or an 80-line weekly shop. The count is
            back, now paired with the estimated value (the
            number the approve decision actually turns on) and
            NOT with the old totalQty, which summed kg and pcs
            into one meaningless figure.

            The "has notes" badge stays — still the only
            pre-expand signal for a free-text request. */}
          <span className="whitespace-nowrap text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('approval.itemsCount', { n: row.itemCount })}
          </span>
          {row.estimatedTotal ? (
            <span
              className="whitespace-nowrap text-old-body font-semibold tabular-nums text-[var(--c-fg)]"
              title={i18n.t('order.review.estimateHint', {
                known: row.estimatedKnown,
                unknown: row.estimatedUnknown,
              })}
            >
              ~{formatMoney(row.estimatedTotal, currency)}
            </span>
          ) : null}
          {/* APR-5 (2026-10-30): the unpriced count lived only in
            a title tooltip, which a phone never shows, so a
            partial sum read as the whole order's cost. */}
          {row.estimatedTotal && Number(row.estimatedUnknown) > 0 ? (
            <span className="whitespace-nowrap text-old-label text-[var(--c-warning-fg)]">
              {i18n.t('approval.estimateUnpriced', { n: row.estimatedUnknown })}
            </span>
          ) : null}
          {/* 2026-10-11: the budget by payment method. Nothing
            is paid yet; this is how each product was paid
            the last time it was bought. One under the other:
            side by side they are wider than the card leaves
            room for on a phone. */}
          {/* CMP-APR-6: only when both parts are above 0. */}
          {row.estimatedTotal && showPaymentSplit(row.estimatedCash, row.estimatedTransfer) ? (
            <span
              // V10: the figures in tabular digits, as the
              // card's total beside them (UI-14).
              data-testid="approval-payment-budget"
              className="flex flex-col items-end text-old-label tabular-nums text-[var(--c-fg-muted)]"
            >
              <span className="whitespace-nowrap">
                {i18n.t('run.label.paymentCash')}{' '}
                <span className="tabular-nums">~{formatMoney(Number(row.estimatedCash))}</span>
              </span>
              <span className="whitespace-nowrap">
                {i18n.t('run.label.paymentTransfer')}{' '}
                <span className="tabular-nums">~{formatMoney(Number(row.estimatedTransfer))}</span>
              </span>
            </span>
          ) : null}
          {/* 2026-10-21 audit CA-27 (B-14): new orders only write
            structured extras (M3.16-C), so a badge keyed on the
            legacy `notes` alone never fired for them. */}
          {/* CMP-APR-7: other items and the note each name
            themselves; "备注 · 2" counted the items. */}
          {requests.extras > 0 ? (
            <Badge tone="warn">{i18n.t('order.batches.extras', { n: requests.extras })}</Badge>
          ) : null}
          {requests.hasNote ? (
            <Badge tone="warn" title={i18n.t('order.notes.hasNote')}>
              {i18n.t('order.notes.badge')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      {isClaimedByOther ? (
        <div className="px-4 pt-2">
          {/* Before 2026-05-18: this banner hardcoded `who: 'reviewer'`
            so every claimed-by-other row read literally
            "Under review by reviewer" — nobody could tell
            WHO was sitting on it. The backend now ships
            `claimedByDisplayName` (see order.pendingList).
            Fallback to a generic label only when the
            claimer's member row was archived. */}
          <Banner
            tone="warn"
            title={
              row.previousClaimerDisplayName
                ? // M3.22 (2026-05-18): when a previous claimer
                  // got force-released (override / timeout) and
                  // someone else picked up the order, show the
                  // handoff so the next approver knows this is
                  // not a first-time claim.
                  i18n.t('order.banner.claimedAfterHandoff', {
                    who: row.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
                    prev: row.previousClaimerDisplayName,
                  })
                : i18n.t('order.banner.claimed', {
                    who: row.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
                  })
            }
            action={
              // Take-over escape valve: anyone with `order.approve`
              // on this store can release another approver's stale
              // claim. Server validates the same permission and
              // records `ClaimReleased{reason:'override'}` for
              // audit (commands.ts 2026-05-18). Self-release stays
              // on the in-row "Release" button below. ORD-28: in
              // the card's store, as the server checks it.
              hasStorePermission(session, row.storeId, 'order.approve') ? (
                <Button
                  size="sm"
                  variant="pearl"
                  loading={busy.takingOver}
                  onClick={() =>
                    confirmThen(
                      i18n.t('approval.confirmTakeover', {
                        who: row.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
                      }),
                      onTakeOver,
                    )
                  }
                >
                  {i18n.t('approval.takeOver')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {row.status === 'rejected' ? (
        <div className="px-4 pt-2">
          {/* UI-2 (declutter): status is stated once — by the
            已拒绝 tab and the danger-tone box. The callout
            shows only the reason; previously it doubled
            "已拒绝" in both the title and the body line.
            A note, not an alert (UI-22): the rejected tab
            draws one per card, all at once. */}
          <Banner tone="danger" role="note">
            {row.rejectReason ? row.rejectReason : i18n.t('order.status.rejectedNoReason')}
          </Banner>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {/* DX-IX-9 (2026-11-01): review decisions are not kept
          on the phone, so offline they are disabled with the
          reason, rather than failing after the tap. */}
        {!online && (tab === 'pending' || tab === 'approved') ? (
          <p className="w-full text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('approval.offline.needsConnection')}
          </p>
        ) : null}
        {/* 2026-10-21 CA-42: an unclaimed order can be approved or
          rejected directly — the domain already allows it
          (commands.ts Approve/Reject only conflict when someone
          ELSE holds the claim), and another approver's claim still
          hides these buttons. Simplification V1 (2026-11-13): no
          "I'll review" step in front of them; the first quantity
          change claims the order (U2), and Release lets it go. */}
        {tab === 'pending' && (!row.claimedByMemberId || isClaimedByMe) && !canApproveRow ? (
          // DX-APR-8: every line set to 0 and no other items —
          // the server refuses to approve; say so instead.
          <p
            data-testid="approval-empty-order"
            className="w-full text-old-label text-[var(--c-warning-fg)]"
          >
            {i18n.t('approval.allZeroRejectOnly')}
          </p>
        ) : null}
        {tab === 'pending' && (!row.claimedByMemberId || isClaimedByMe) ? (
          <>
            {canApproveRow ? (
              <Button
                size="sm"
                variant="primary"
                loading={busy.approving}
                disabled={!online || adjusting || held}
                onClick={onApprove}
              >
                {adjusting ? i18n.t('common.savingSlow') : i18n.t('approval.approve')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="danger"
              disabled={!online || adjusting || busy.approving}
              onClick={onReject}
            >
              {i18n.t('approval.reject')}
            </Button>
            {isClaimedByMe ? (
              <Button
                size="sm"
                variant="pearl"
                loading={busy.releasing}
                disabled={!online}
                onClick={onRelease}
              >
                {i18n.t('approval.release')}
              </Button>
            ) : null}
          </>
        ) : null}
        {/* M1.7-fix (2026-05-07, audit HIGH #5): only show
          Unapprove if the actor actually has the perm.
          Earlier rev rendered for everyone in the
          approved tab — managers without
          `order.unapprove` would tap and get a 403
          toast, which looks like the app is broken. */}
        {tab === 'approved' && hasStorePermission(session, row.storeId, 'order.unapprove') ? (
          <Button
            size="sm"
            variant="pearl"
            loading={busy.unapproving}
            disabled={!online}
            // APR-7 (2026-10-30): one tap used to send the order
            // back at once; the prompt was written but unused.
            onClick={() =>
              confirmThen(
                `${i18n.t('approval.confirm.unapprove.title')}\n\n${i18n.t('approval.confirm.unapprove.body')}`,
                onUnapprove,
              )
            }
          >
            {i18n.t('approval.unapprove')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          // A11Y-13 (2026-10-31): says that it opens the lines
          // below, and whether they are open.
          aria-expanded={open}
          aria-controls={open ? `approval-items-${row.id}` : undefined}
          onClick={onToggleItems}
        >
          {open ? i18n.t('approval.hideItems') : i18n.t('approval.viewItems')}
        </Button>
      </div>

      {open ? (
        <div id={`approval-items-${row.id}`}>
          <SessionItems
            sessionId={row.id}
            storeId={row.storeId}
            skuById={skuById}
            productName={productName}
            isClaimedByMe={isClaimedByMe}
            // U2: an unclaimed pending order can be edited too; the
            // first change claims it (server side, one write).
            claimOnEditSeq={
              tab === 'pending' &&
              !row.claimedByMemberId &&
              hasStorePermission(session, row.storeId, 'order.claim')
                ? row.lastSeq
                : undefined
            }
            onHold={onHold}
          />
        </div>
      ) : null}
    </Card>
  );
}
