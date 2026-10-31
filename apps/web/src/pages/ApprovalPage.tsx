/**
 * ApprovalPage — manager queue.
 *
 * Lists submitted sessions enriched with store / member / item-count metadata
 * (single round-trip via `order.pendingList`). Atomically claim → review →
 * approve / reject. Per-card item view uses the dedicated
 * `order.sessionDetail({id})` endpoint.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  DataState,
  EmptyState,
  Field,
  Input,
  QtyControl,
  SectionLabel,
  Sheet,
  Spinner,
  StickyPageBar,
  Tab,
  Tabs,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../hooks/useI18n';
import { isWaitingOffline } from '../components/PendingSpinner';
import { haptic } from '../hooks/useTelegram';
import { confirmThen } from '../lib/confirm';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';
import { useStoreContext } from '../components/StoreSwitcher';
import { sessionItemsView } from './approval/sessionItemsView';
import { cardRequests, showPaymentSplit } from './approval/cardSummary';
import { ORDER_QTY_MAX } from '@compass/contracts/limits';

type ApprovalTab = 'pending' | 'approved' | 'rejected';

const confirmAction = confirmThen;

/** D12: how long the approval toast offers to take it back. */
const UNDO_APPROVE_MS = 5000;

export function ApprovalPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // CA-43: the row version the reject sheet was opened on.
  const [rejectSeq, setRejectSeq] = useState<number | undefined>(undefined);
  // Store-context comes from the global header picker (added 2026-05-05).
  // Replaces the local chip-bar filter — same UX outcome but now the
  // selection follows the user across pages.
  //   'specific' → filter pendingList by that store
  //   'all'      → no filter (server still scopes to actor's allowed set)
  //   'none'     → user has no stores; refuse to query
  const storeCtx = useStoreContext();
  /** Filtered to a single store — the chip already names it. */
  const storeScoped = storeCtx.kind === 'specific';

  const myStores = session?.stores ?? [];

  // pendingList accepts an optional status filter; we drive the tab
  // off it. 'pending' on the FE means 'submitted' on the server (the
  // actual enum value); the other tabs map 1:1.
  const pendingQuery = trpc.order.pendingList.useQuery(
    {
      status: tab === 'pending' ? 'submitted' : tab,
      ...(storeCtx.kind === 'specific' ? { storeId: storeCtx.storeId } : {}),
    },
    { enabled: storeCtx.kind !== 'none' },
  );
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });

  const utils = trpc.useUtils();
  const toast = useToast();
  // Audit-found 2026-05-05: every mutation here used to onError ONLY haptic.
  // Manager taps Approve, network fails, they feel a buzz and assume "done"
  // since the toast they're used to never appears. Bad. Now every error
  // path surfaces a toast — domain errors get the i18n'd code translated;
  // unknown errors get a generic "something went wrong". M1.9 (2026-05-07):
  // hoisted the regex + handler shape into `lib/errToast.ts` so the same
  // logic lives in one place and we can't drift across pages.
  const errToast = useErrToast();
  const claim = trpc.order.claim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.claimed'));
    },
    onError: errToast('common.error'),
  });
  // 2026-10-21 audit CA-43 "approve what you saw": approve / reject send
  // the `lastSeq` of the row on screen; the server answers CONFLICT
  // order.errors.staleSeq when the staff changed the order after that.
  // Then the card is out of date — reload it and say so, rather than
  // the generic "someone else just edited — retry" (a blind retry would
  // approve the new version unseen, which is the bug).
  const isOrderChanged = (err: unknown): boolean => {
    const e = err as { data?: { code?: string }; message?: string } | undefined;
    return e?.data?.code === 'CONFLICT' && e.message === 'order.errors.staleSeq';
  };
  const onOrderChanged = (sessionId: string) => {
    void utils.order.pendingList.invalidate();
    void utils.order.sessionDetail.invalidate({ sessionId });
    haptic('warning');
    toast.info(i18n.t('approval.toast.orderChanged'));
  };
  // APR-10 (2026-10-30): a double tap sent two approvals; the second lost
  // on the unique index and toasted "changed since you opened it" right
  // after "approved". One in flight per order.
  const approving = useRef(new Set<string>());
  const approveOnce = (sessionId: string, expectedSeq: number) => {
    if (approving.current.has(sessionId)) return;
    approving.current.add(sessionId);
    approve.mutate(
      { sessionId, expectedSeq },
      { onSettled: () => approving.current.delete(sessionId) },
    );
  };
  const approve = trpc.order.approve.useMutation({
    onSuccess: (data, vars) => {
      void utils.order.pendingList.invalidate();
      haptic('success');
      // D12 (U1, 2026-10-31): the card's 通过 stays one tap, with five
      // seconds to take it back. The undo is the normal unapprove, sent
      // with the lastSeq this approval produced, so it is refused once
      // anyone else has touched the order.
      if (!session?.permissions.includes('order.unapprove')) {
        toast.success(i18n.t('approval.toast.approved'));
        return;
      }
      toast.show(i18n.t('approval.toast.approved'), {
        tone: 'success',
        ttlMs: UNDO_APPROVE_MS,
        actions: [
          {
            label: i18n.t('approval.undo'),
            onClick: () =>
              undoApprove.mutate({ sessionId: vars.sessionId, expectedSeq: data.lastSeq }),
          },
        ],
      });
    },
    onError: (err, vars) => {
      if (isOrderChanged(err)) return onOrderChanged(vars.sessionId);
      errToast('approval.toast.approveFailed')(err);
    },
  });
  const reject = trpc.order.reject.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      setRejectFor(null);
      setRejectReason('');
      haptic('warning');
      toast.info(i18n.t('approval.toast.rejected'));
    },
    onError: (err, vars) => {
      if (isOrderChanged(err)) {
        // Close the sheet: the reason was written against a version
        // that no longer exists. The approver re-reads and decides again.
        setRejectFor(null);
        setRejectReason('');
        return onOrderChanged(vars.sessionId);
      }
      errToast('approval.toast.rejectFailed')(err);
    },
  });
  const takeOverClaim = trpc.order.takeOverClaim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.tookOver'));
    },
    // RE-APR-2: someone else took it over first — show who has it now.
    onError: (err) => {
      void utils.order.pendingList.invalidate();
      errToast('common.error')(err);
    },
  });
  const dates = useDateFormat();
  const releaseClaim = trpc.order.releaseClaim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.released'));
    },
    onError: errToast('common.error'),
  });
  const undoApprove = trpc.order.unapprove.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.unapproved'));
    },
    onError: (err) => {
      void utils.order.pendingList.invalidate();
      if (isOrderChanged(err)) {
        haptic('warning');
        toast.info(i18n.t('approval.toast.undoTooLate'));
        return;
      }
      errToast('common.error')(err);
    },
  });
  const unapprove = trpc.order.unapprove.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.unapproved'));
    },
    onError: (err) => {
      // APR-8: the card may be stale (a run took the order); refresh it.
      void utils.order.pendingList.invalidate();
      errToast('common.error')(err);
    },
  });

  // D13 (APR-12 / APR-13, 2026-10-31): the reviewer whose claim timed out
  // or was taken over saw the card quietly change. The server leaves an
  // in-app notification; on this page say it at once. Orders this
  // reviewer let go of themselves (release / approve / reject) are not
  // reported.
  const myClaims = useRef(new Set<string>());
  const letGo = useRef(new Set<string>());
  useEffect(() => {
    if (tab !== 'pending' || !pendingQuery.data) return;
    const me = session?.member.memberId;
    const rows = new Map(pendingQuery.data.map((r) => [r.id, r]));
    for (const id of myClaims.current) {
      const r = rows.get(id);
      if (!r || r.claimedByMemberId === me) continue;
      if (letGo.current.delete(id)) continue;
      haptic('warning');
      toast.info(
        r.claimedByMemberId
          ? i18n.t('approval.toast.claimTakenOver', {
              owner: r.attribDisplayName ?? '',
              who: r.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
            })
          : i18n.t('approval.toast.claimTimedOut', { owner: r.attribDisplayName ?? '' }),
      );
    }
    myClaims.current = new Set(
      pendingQuery.data.filter((r) => me && r.claimedByMemberId === me).map((r) => r.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery.data, tab]);

  // 2026-07-30 (flow review): `step` was missing from this map while
  // SessionItems read `Number(sku.step ?? '1')` — and its prop type had
  // `step?: string`, so TS never complained. Net effect: the approver's
  // +/- moved in whole units for EVERY SKU. A 0.1 kg-step herb and a
  // 0.5 kg-step vegetable both jumped by 1 here, while the Order screen
  // the quantity came from used the real step. `step` is required in the
  // prop type below now, so the same omission can't come back silently.
  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string; step: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
      });
    }
    return m;
  }, [skusQuery.data]);

  if (!session) return null;

  // M1.11 cleanup (2026-05-08): subtitle dropped — the Tabs row
  // immediately below + the empty-state Card (when count===0) +
  // the Card list itself already convey "what state am I in" and
  // "how many". The redundant "X items" line just compressed the
  // SKU list further.
  return (
    <div className="flex flex-col">
      {/* M3.5: store-switcher pill moved to SettingsSheet. The sticky
         band now only carries the approval-state Tabs. */}
      <StickyPageBar direction="col">
        {/* 2026-07-30: which store's queue am I looking at? The list is
            filtered by store context but never said so. On 'all' the chip
            reads 所有门店, which is equally load-bearing. Answered by the
            chip in Shell's top strip now (same day) rather than a copy
            per page — this strip is back to just the state Tabs. */}
        {/* M1.9-extra (P6, 2026-05-07): real <Tabs> with roving
            tabindex + ArrowLeft/ArrowRight/Home/End nav. Was
            `ChipBar`-as-tabs with role=tablist/tab on the buttons
            but no keyboard-cycle behaviour. */}
        <Tabs
          value={tab}
          onChange={(v) => setTab(v as ApprovalTab)}
          ariaLabel={i18n.t('approval.tabsAriaLabel')}
        >
          <Tab value="pending">{i18n.t('approval.tab.pending')}</Tab>
          <Tab value="approved">{i18n.t('approval.tab.approved')}</Tab>
          <Tab value="rejected">{i18n.t('approval.tab.rejected')}</Tab>
        </Tabs>
      </StickyPageBar>

      {myStores.length === 0 &&
      !session.permissions.includes('users.manage') ? (
        // Manager dragged of all stores mid-shift, or never assigned.
        // Don't even fire the query — they'd just see an empty queue
        // with no explanation.
        <div className="px-4 py-8">
          <EmptyState
            title={i18n.t('auth.noStore.title')}
            description={i18n.t('auth.noStore.body')}
          />
        </div>
      ) : (
      <div className="px-4 pt-3">
      <DataState
        query={pendingQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          // APR-14 (2026-10-30): the approved / rejected tabs said "inbox
          // empty — new orders will appear here"; the per-tab line was unused.
          tab === 'pending' ? (
            <EmptyState
              title={i18n.t('approval.empty.title')}
              description={i18n.t('approval.empty.body')}
            />
          ) : (
            <EmptyState
              title={i18n.t('approval.empty.tab', {
                tab: i18n.t(`approval.tab.${tab}` as Parameters<typeof i18n.t>[0]),
              })}
            />
          )
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((row) => {
              const isClaimedByMe = row.claimedByMemberId === session.member.memberId;
              const isClaimedByOther =
                row.claimedByMemberId && row.claimedByMemberId !== session.member.memberId;
              const isOpen = activeSessionId === row.id;
              const requests = cardRequests(row.notes, row.extrasJson);
              return (
                <Card as="li" key={row.id}>
                  {/* A11Y-1 (2026-10-31): the amounts move under the name when
                      the card is too narrow (200% zoom) instead of running
                      off its edge. */}
                  <CardHeader className="flex-wrap">
                    <div className="flex min-w-[8rem] flex-1 items-center gap-3">
                      {/* The avatar is the SUBMITTER's photo (`attribAvatarUrl`),
                          so `name` — which supplies both the alt text and the
                          initials fallback — has to be the submitter too.
                          2026-07-30: it was the STORE name, so a screen reader
                          announced a person's face as "Eden Magic City", and a
                          submitter without a photo got the store's initials. */}
                      <Avatar
                        src={row.attribAvatarUrl}
                        name={row.attribDisplayName ?? '?'}
                        size={32}
                      />
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
                            ? (row.attribDisplayName ?? i18n.t('approval.unknownReviewer'))
                            : (row.storeName?.trim() ?? row.storeId.slice(0, 8))}
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
                          {row.submittedAt &&
                          rows.some(
                            (o) =>
                              o.id !== row.id &&
                              o.orderDate === row.orderDate &&
                              o.attribDisplayName === row.attribDisplayName,
                          )
                            ? ' · ' + dates.time(row.submittedAt)
                            : ''}
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

                          The "has notes" 📝 pill stays — still the only
                          pre-expand signal for a free-text request. */}
                      <span className="whitespace-nowrap text-old-label tabular-nums text-[var(--c-fg-muted)]">
                        {i18n.t('approval.itemsCount', { n: row.itemCount })}
                      </span>
                      {row.estimatedTotal ? (
                        <span
                          className="whitespace-nowrap font-mono text-old-body font-semibold tabular-nums text-[var(--c-fg)]"
                          title={i18n.t('order.review.estimateHint', {
                            known: row.estimatedKnown,
                            unknown: row.estimatedUnknown,
                          })}
                        >
                          ~{formatMoney(Number(row.estimatedTotal))}
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
                      {row.estimatedTotal &&
                      showPaymentSplit(row.estimatedCash, row.estimatedTransfer) ? (
                        <span
                          // V10: the figures in the same mono face as the
                          // card's total beside them.
                          data-testid="approval-payment-budget"
                          className="flex flex-col items-end text-old-label tabular-nums text-[var(--c-fg-muted)]"
                        >
                          <span className="whitespace-nowrap">
                            {i18n.t('run.label.paymentCash')}{' '}
                            <span className="font-mono">
                              ~{formatMoney(Number(row.estimatedCash))}
                            </span>
                          </span>
                          <span className="whitespace-nowrap">
                            {i18n.t('run.label.paymentTransfer')}{' '}
                            <span className="font-mono">
                              ~{formatMoney(Number(row.estimatedTransfer))}
                            </span>
                          </span>
                        </span>
                      ) : null}
                      {/* 2026-10-21 audit CA-27 (B-14): new orders only write
                          structured extras (M3.16-C), so a badge keyed on the
                          legacy `notes` alone never fired for them. */}
                      {/* CMP-APR-7: other items and the note each name
                          themselves; "备注 · 2" counted the items. */}
                      {requests.extras > 0 ? (
                        <Badge tone="warn">
                          {i18n.t('order.batches.extras', { n: requests.extras })}
                        </Badge>
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
                                who:
                                  row.claimedByDisplayName ??
                                  i18n.t('approval.unknownReviewer'),
                                prev: row.previousClaimerDisplayName,
                              })
                            : i18n.t('order.banner.claimed', {
                                who:
                                  row.claimedByDisplayName ??
                                  i18n.t('approval.unknownReviewer'),
                              })
                        }
                        action={
                          // Take-over escape valve: anyone with `order.approve`
                          // on this store can release another approver's stale
                          // claim. Server validates the same permission and
                          // records `ClaimReleased{reason:'override'}` for
                          // audit (commands.ts 2026-05-18). Self-release stays
                          // on the in-row "Release" button below.
                          session.permissions.includes('order.approve') ? (
                            <Button
                              size="sm"
                              variant="pearl"
                              loading={
                                takeOverClaim.isPending &&
                                takeOverClaim.variables?.sessionId === row.id
                              }
                              onClick={() =>
                                confirmAction(
                                  i18n.t('approval.confirmTakeover', {
                                    who: row.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
                                  }),
                                  () =>
                                    takeOverClaim.mutate({
                                      sessionId: row.id,
                                      // RE-APR-2: take over this claim, no other.
                                      fromMemberId: row.claimedByMemberId ?? undefined,
                                    }),
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
                          "已拒绝" in both the title and the body line. */}
                      <Banner tone="danger">
                        {row.rejectReason
                          ? row.rejectReason
                          : i18n.t('order.status.rejectedNoReason')}
                      </Banner>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                    {/* 2026-10-21 CA-42: an unclaimed order can be approved or
                        rejected directly — the domain already allows it
                        (commands.ts Approve/Reject only conflict when someone
                        ELSE holds the claim). Claim stays for editing
                        quantities, and another approver's claim still hides
                        these buttons. While a claim or approval for this row
                        is in flight the other actions wait, so a quick
                        Claim → Approve can't race two writes onto the same
                        order stream (the loser would fail with staleSeq). */}
                    {tab === 'pending' && !row.claimedByMemberId ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={approve.isPending && approve.variables?.sessionId === row.id}
                          disabled={claim.isPending && claim.variables?.sessionId === row.id}
                          onClick={() => approveOnce(row.id, row.lastSeq)}
                        >
                          {i18n.t('approval.approve')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={
                            (claim.isPending && claim.variables?.sessionId === row.id) ||
                            (approve.isPending && approve.variables?.sessionId === row.id)
                          }
                          onClick={() => {
                            setRejectFor(row.id);
                            setRejectSeq(row.lastSeq);
                          }}
                        >
                          {i18n.t('approval.reject')}
                        </Button>
                        <Button
                          size="sm"
                          variant="pearl"
                          loading={claim.isPending && claim.variables?.sessionId === row.id}
                          disabled={approve.isPending && approve.variables?.sessionId === row.id}
                          onClick={() => {
                            claim.mutate({ sessionId: row.id });
                            setActiveSessionId(row.id);
                          }}
                        >
                          {i18n.t('approval.claim')}
                        </Button>
                      </>
                    ) : null}
                    {tab === 'pending' && isClaimedByMe ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={approve.isPending && approve.variables?.sessionId === row.id}
                          onClick={() => approveOnce(row.id, row.lastSeq)}
                        >
                          {i18n.t('approval.approve')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setRejectFor(row.id);
                            setRejectSeq(row.lastSeq);
                          }}
                        >
                          {i18n.t('approval.reject')}
                        </Button>
                        <Button
                          size="sm"
                          variant="pearl"
                          loading={
                            releaseClaim.isPending &&
                            releaseClaim.variables?.sessionId === row.id
                          }
                          onClick={() => {
                            letGo.current.add(row.id);
                            releaseClaim.mutate({ sessionId: row.id });
                          }}
                        >
                          {i18n.t('approval.release')}
                        </Button>
                      </>
                    ) : null}
                    {/* M1.7-fix (2026-05-07, audit HIGH #5): only show
                        Unapprove if the actor actually has the perm.
                        Earlier rev rendered for everyone in the
                        approved tab — managers without
                        `order.unapprove` would tap and get a 403
                        toast, which looks like the app is broken. */}
                    {tab === 'approved' &&
                    session.permissions.includes('order.unapprove') ? (
                      <Button
                        size="sm"
                        variant="pearl"
                        loading={
                          unapprove.isPending && unapprove.variables?.sessionId === row.id
                        }
                        // APR-7 (2026-10-30): one tap used to send the order
                        // back at once; the prompt was written but unused.
                        onClick={() =>
                          confirmAction(
                            `${i18n.t('approval.confirm.unapprove.title')}\n\n${i18n.t('approval.confirm.unapprove.body')}`,
                            () => unapprove.mutate({ sessionId: row.id }),
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
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? `approval-items-${row.id}` : undefined}
                      onClick={() => setActiveSessionId(isOpen ? null : row.id)}
                    >
                      {isOpen ? i18n.t('approval.hideItems') : i18n.t('approval.viewItems')}
                    </Button>
                  </div>

                  {isOpen ? (
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
                          session.permissions.includes('order.claim')
                            ? row.lastSeq
                            : undefined
                        }
                      />
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
      </div>
      )}

      <Sheet
        open={!!rejectFor}
        onOpenChange={(open) => {
          // M3.10: block dismiss while the reject mutation is in flight.
          // Pre-M3.10 a swipe-down here wiped both rejectFor and
          // rejectReason in local state; if the mutation then failed,
          // the operator saw an error toast but their typed reason was
          // gone and they had to re-author it. Now the sheet stays
          // pinned until the mutation settles — onSuccess naturally
          // closes via setRejectFor(null), onError leaves the sheet
          // open with the reason intact for a quick retry.
          if (!open && reject.isPending) return;
          if (!open) {
            setRejectFor(null);
            setRejectReason('');
          }
        }}
        // CMP-INT-2: a typed reason is not dropped by Esc / backdrop / back
        // without asking (while saving, the sheet stays open anyway).
        hasChanges={!reject.isPending && rejectReason.trim() !== ''}
        title={i18n.t('approval.confirm.reject.title')}
        description={i18n.t('approval.confirm.reject.body')}
        // M1.9-fix (2026-05-07): the reason input used to autoFocus on
        // open, popping the iOS keyboard during slideUp and pushing
        // the Reject button out of view. We DEFER the autofocus until
        // after slideUp finishes (~240ms) so focus + keyboard arrive
        // when the sheet is in its final position — keyboard nav and
        // screen-reader users still get focus inside the dialog.
        deferAutoFocusMs={280}
        footer={
          <Button
            block
            variant="danger"
            disabled={!rejectReason.trim()}
            loading={reject.isPending}
            onClick={() => {
              if (!rejectFor) return;
              reject.mutate({
                sessionId: rejectFor,
                reason: rejectReason.trim(),
                expectedSeq: rejectSeq,
              });
            }}
          >
            {i18n.t('approval.reject')}
          </Button>
        }
      >
        <div className="py-3">
          {/* A11Y-9 (2026-10-31): a real label; the placeholder ("例如：重复
              下单") was the field's only name and vanished on typing. */}
          <Field label={i18n.t('approval.confirm.reject.reasonLabel')}>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={i18n.t('approval.confirm.reject.reasonPlaceholder')}
              maxLength={500}
              required
              aria-required
            />
          </Field>
        </div>
      </Sheet>
    </div>
  );
}

/**
 * Per-SKU expanded view inside the approval queue. Shows the running
 * total per SKU AND a sub-list of each contributor's qty (per #6 — the
 * manager wants to see who asked for what). Each contributor row has
 * a +/- control so the manager can adjust in place WITHOUT bouncing
 * the order back to draft. The mutation uses `targetMemberId` so the
 * server applies the manager-override path.
 */
function SessionItems({
  sessionId,
  storeId,
  skuById,
  productName,
  isClaimedByMe,
  claimOnEditSeq,
}: {
  sessionId: string;
  storeId: string;
  // `step` is REQUIRED (2026-07-30) — see the skuById docblock in the
  // parent. An optional `step` is how the whole-unit-increment bug hid.
  skuById: Map<string, { names: Record<string, string>; unit: string; step: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  isClaimedByMe: boolean;
  /** U2 (2026-10-31): set when the order is unclaimed and the viewer may
   *  claim it — the version on screen. A quantity change then claims the
   *  order in the same write, refused if someone changed it since. */
  claimOnEditSeq?: number;
}) {
  const i18n = useI18n();
  const canEdit = isClaimedByMe || claimOnEditSeq !== undefined;
  const unitLabel = useUnitLabel();
  // M1.21: pull org currency from session for the estimate-total
  // suffix. Hardcoded "UZS" pre-M1.21 blocked the multi-currency
  // foundation from M1.17.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const detail = trpc.order.sessionDetail.useQuery({ sessionId });
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const adjust = trpc.order.adjustItem.useMutation({
    onSuccess: () => {
      void utils.order.sessionDetail.invalidate({ sessionId });
      void utils.order.pendingList.invalidate();
    },
    onError: (err) => {
      // U2: the order changed or someone claimed it first — show it as it is now.
      void utils.order.sessionDetail.invalidate({ sessionId });
      void utils.order.pendingList.invalidate();
      errToast('order.toast.adjustFailed')(err);
    },
  });
  // Member directory lookup so we can show who contributed each row.
  const membersQuery = trpc.admin.memberList.useQuery(undefined, {
    // memberList requires users.manage. Managers usually have it; if not,
    // fall back to showing the bare member id instead of erroring.
    enabled: canEdit,
    retry: false,
  });
  const memberById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of membersQuery.data ?? []) m.set(row.memberId, row.displayName);
    return m;
  }, [membersQuery.data]);

  // skuPriceStats hooked here (BEFORE early returns, fixed 2026-05-05)
  // so React's hooks-order invariant holds across loading/empty/error
  // branches. Manager sees estimated budget before approving.
  // skuIds derived from detail.data so it's stable across renders.
  const skuIdsForPrice = useMemo(
    () => (detail.data?.totals ?? []).filter((t) => Number(t.qty) > 0).map((t) => t.skuId),
    [detail.data],
  );
  // D6 (2026-10-31): priced for the order's store (no amounts where the
  // approver lacks prices.view).
  const priceStats = trpc.catalog.skuPriceStats.useQuery(
    { skuIds: skuIdsForPrice, storeId: detail.data?.storeId },
    { enabled: skuIdsForPrice.length > 0, staleTime: 60_000 },
  );

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
        <Spinner size={14} /> {i18n.t('approval.items.loading')}
      </div>
    );
  }
  if (isWaitingOffline(detail)) {
    // R2-ENG-1 (2026-10-31): offline, an order never opened before has no
    // saved lines; it is not an empty order.
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('common.offlineNoData')}
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-danger)]">
        {i18n.t('approval.items.failed')}
      </div>
    );
  }
  const totals = (detail.data?.totals ?? []).filter((t) => Number(t.qty) > 0);
  const rawItems = detail.data?.items ?? [];
  // The same price the estimate below is made of: the last price paid.
  const priceBySku = new Map(
    (priceStats.data ?? []).map((r) => [r.skuId, r.lastPrice]),
  );
  const estimateTotal = (() => {
    let sum = 0;
    let known = 0;
    let unknown = 0;
    const priceMap = priceBySku;
    for (const t of totals) {
      const price = priceMap.get(t.skuId);
      if (price) {
        sum += Number(price) * Number(t.qty);
        known++;
      } else {
        unknown++;
      }
    }
    return { sum, known, unknown };
  })();
  const sessionNotes = detail.data?.notes ?? null;
  const sessionExtras = detail.data?.extras ?? [];
  // 2026-10-21 FE-02: the empty state used to return before extras and
  // notes rendered, so an extras-only order read "empty" to the manager.
  // Now "empty" covers the SKU section only; the whole block reads empty
  // only when SKUs, extras and notes are all absent.
  const view = sessionItemsView({ totals, extras: sessionExtras, notes: sessionNotes });
  if (view.allEmpty) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('approval.items.empty')}
      </div>
    );
  }

  // Group raw items by SKU for the breakdown.
  const rowsBySku = new Map<string, Array<{ contributorMemberId: string; qty: string }>>();
  for (const it of rawItems) {
    if (Number(it.qty) <= 0) continue;
    const arr = rowsBySku.get(it.skuId) ?? [];
    arr.push({ contributorMemberId: it.contributorMemberId, qty: it.qty });
    rowsBySku.set(it.skuId, arr);
  }


  return (
    <div className="border-t border-[var(--c-divider)]">
    {/* Session-level "其他物品" requests. M1.8 carried free-text in
        `notes`; M3.16-C ships a structured list in `extras`. Both
        surfaces render side-by-side here (legacy notes from pre-M3.16
        sessions + new extras from M3.16+ sessions) so the manager
        sees everything the store asked for in one place. Yellow tint
        because these are off-catalog and need extra scrutiny. */}
    {view.showExtras ? (
      <div className="border-b border-[var(--c-divider)] bg-[var(--c-warn-bg)] px-4 py-2.5">
        <SectionLabel padded={false}>
          {i18n.t('order.extras.label')}
        </SectionLabel>
        <ul className="mt-1 flex flex-col gap-0.5">
          {sessionExtras.map((e, idx) => (
            <li
              key={`${e.name}-${idx}`}
              className="flex items-baseline justify-between gap-2 text-old-body"
            >
              <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">{e.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                {formatQty(e.qty)} {unitLabel(e.unit, e.qty)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {view.showNotes ? (
      <div className="border-b border-[var(--c-divider)] bg-[var(--c-warn-bg)] px-4 py-2.5">
        <SectionLabel padded={false}>
          {i18n.t('order.notes.label')}
        </SectionLabel>
        <div className="mt-1 whitespace-pre-wrap text-old-body leading-snug text-[var(--c-fg)]">
          {sessionNotes}
        </div>
      </div>
    ) : null}
    {/* Estimated budget row (added 2026-05-05). Tells the manager
        roughly how much approval-then-purchase will cost, based on
        the last 7 days of price history. SKUs with no history skip
        and are flagged. */}
    {estimateTotal.known > 0 ? (
      <div className="flex items-baseline justify-between gap-2 px-4 py-2 text-old-label text-[var(--c-fg-muted)]">
        <span className="font-semibold uppercase tracking-eyebrow">
          {i18n.t('order.review.estimatedTotal')}
        </span>
        <span className="font-mono text-old-body font-semibold tabular-nums text-[var(--c-fg)]">
          ~{formatMoney(estimateTotal.sum)} {currency}
          {estimateTotal.unknown > 0 ? (
            <span className="ml-2 font-sans font-normal text-[var(--c-warning-fg)]">
              {i18n.t('approval.estimateUnpriced', { n: estimateTotal.unknown })}
            </span>
          ) : null}
        </span>
      </div>
    ) : null}
    {view.skuSectionEmpty ? (
      <div className="px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('approval.items.noCatalogItems')}
      </div>
    ) : null}
    {view.hasSkus ? (
    <ul
      className="flex flex-col px-4 py-2"
      role="list"
    >
      {totals.map((t) => {
        const sku = skuById.get(t.skuId);
        const rows = rowsBySku.get(t.skuId) ?? [];
        // M3.34 (2026-05-19, Q4 cleanup): collapse the contributor
        // breakdown when there's only ONE contributor. The submitter's
        // name is already in the order card header; repeating it on
        // every SKU row was redundant and ate screen space. For a
        // single-contributor session in claimed mode, the QtyControl
        // moves up onto the SKU header itself in place of the static
        // qty span.
        const isSingleContributor = rows.length === 1;
        const singleRow = isSingleContributor ? rows[0]! : null;
        const unitPrice = Number(priceBySku.get(t.skuId) ?? 0) || null;
        return (
          <li key={t.skuId} className="border-b border-[var(--c-divider)] py-3 last:border-b-0">
            <div className="flex items-center justify-between gap-2 text-old-body">
              <span className="min-w-0 flex-1 truncate font-semibold text-[var(--c-fg)]">
                {sku ? productName(sku) : t.skuId.slice(0, 8)}
              </span>
              {canEdit && isSingleContributor && sku && singleRow ? (
                <QtyControl
                  size="sm"
                  itemLabel={productName(sku)}
                  value={Number(singleRow.qty)}
                  step={Number(sku.step)}
                  unit={unitLabel(sku.unit)}
                  max={ORDER_QTY_MAX}
                  disabled={adjust.isPending}
                  onChange={(next) =>
                    adjust.mutate({
                      storeId,
                      // 2026-07-30 (flow review): pass the SESSION's date.
                      // Omitting it made the server default to today, so
                      // adjusting a session submitted on an earlier day
                      // looked up the wrong (store, date) row entirely.
                      date: detail.data?.orderDate,
                      skuId: t.skuId,
                      qty: String(next),
                      targetMemberId: singleRow.contributorMemberId,
                      // APR-1: name the batch being reviewed; the server used to
                      // guess it and could edit the same person's other batch.
                      sessionId,
                      expectedSeq: claimOnEditSeq,
                    })
                  }
                />
              ) : (
                <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg)]">
                  {formatQty(t.qty)} {unitLabel(sku?.unit ?? '', t.qty)}
                </span>
              )}
            </div>
            {/* 2026-10-11: what one costs, how it is usually paid, and
                what the line comes to. A line of its own under the name,
                holding only figures and one word, so a long product name
                in any language has nothing to share its line with. */}
            {unitPrice || t.usualPayment ? (
              <div
                data-testid="approval-line-price"
                className="mt-0.5 flex items-baseline justify-between gap-2 text-old-label tabular-nums text-[var(--c-fg-muted)]"
              >
                <span className="min-w-0">
                  {unitPrice ? `~${formatMoney(unitPrice)} / ${unitLabel(sku?.unit ?? '')}` : null}
                  {unitPrice && t.usualPayment ? ' · ' : null}
                  {t.usualPayment
                    ? i18n.t(
                        t.usualPayment === 'transfer'
                          ? 'run.label.paymentTransfer'
                          : 'run.label.paymentCash',
                      )
                    : null}
                </span>
                {unitPrice ? (
                  <span className="shrink-0 font-mono">
                    ~{formatMoney(unitPrice * Number(t.qty))}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Per-contributor breakdown only when 2+ contributors —
                whether or not claimed. Hiding for single-contributor
                avoids the noisy repeated submitter name. */}
            {rows.length > 1 ? (
              <ul className="mt-1 flex flex-col gap-1 pl-3" role="list">
                {rows.map((r) => (
                  <li
                    key={r.contributorMemberId}
                    className="flex items-center justify-between gap-2 text-old-label text-[var(--c-fg-muted)]"
                  >
                    <span className="truncate">
                      {memberById.get(r.contributorMemberId) ??
                        r.contributorMemberId.slice(0, 6)}
                    </span>
                    {canEdit && sku ? (
                      <QtyControl
                        size="sm"
                        itemLabel={`${productName(sku)} · ${
                          memberById.get(r.contributorMemberId) ??
                          r.contributorMemberId.slice(0, 6)
                        }`}
                        value={Number(r.qty)}
                        step={Number(sku.step)}
                        unit={unitLabel(sku.unit)}
                        max={ORDER_QTY_MAX}
                        disabled={adjust.isPending}
                        onChange={(next) =>
                          adjust.mutate({
                            storeId,
                            date: detail.data?.orderDate,
                            skuId: t.skuId,
                            qty: String(next),
                            targetMemberId: r.contributorMemberId,
                            // APR-1: name the batch being reviewed; the server used to
                            // guess it and could edit the same person's other batch.
                            sessionId,
                            expectedSeq: claimOnEditSeq,
                          })
                        }
                      />
                    ) : (
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatQty(r.qty)} {unitLabel(sku?.unit ?? '', r.qty)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
    ) : null}
    </div>
  );
}

// ManagerLineEditor removed 2026-05-03: replaced by `<QtyControl size="sm">`
// from @compass/ui. The inline reimplementation drifted from the
// canonical +/- control's behavior (haptics, hold-to-repeat, manual
// entry sheet) — promoting to size="sm" gives ApprovalPage all of those
// behaviors for free, and any future improvements to QtyControl land
// here automatically.
