/**
 * ApprovalPage — manager queue.
 *
 * Lists submitted sessions enriched with store / member / item-count metadata
 * (single round-trip via `order.pendingList`). Atomically claim → review →
 * approve / reject. Per-card item view uses the dedicated
 * `order.sessionDetail({id})` endpoint.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutationState } from '@tanstack/react-query';
import { getMutationKey } from '@trpc/react-query';
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
  Sheet,
  StickyPageBar,
  Tab,
  Tabs,
  focusAfter,
  useToast,
} from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useDateFormat, useI18n, useProductName } from '../hooks/useI18n';
import { haptic } from '../lib/telegram';
import { useOnline } from '../hooks/useOnline';
import { confirmThen } from '../lib/confirm';
import { useErrToast } from '../hooks/useErrToast';
import { formatMoney } from '../lib/format';
import { useCurrency } from '../hooks/useCurrency';
import { useStoreContext } from '../hooks/useStoreContext';
import { cardRequests, showPaymentSplit } from './approval/cardSummary';
import { approvable } from './approval/reviewDiff';
import { adjustingSessionIds } from './approval/adjustInFlight';
import { conflictKind } from '../lib/conflict';
import { SessionItems } from './approval/SessionItems';

/** DX-IX-4: where focus goes after a card is decided (the list's first card title). */
const NEXT_CARD = '[data-approval-list] > li h2';

type ApprovalTab = 'pending' | 'approved' | 'rejected';

/**
 * Each tab's name, for the tab and for its empty state. Review ADM2-16 /
 * UI-2 (2026-11-12): the empty state composed the key from the tab and
 * cast it.
 */
const TAB_LABEL_KEYS: Record<ApprovalTab, CatalogKey> = {
  pending: 'approval.tab.pending',
  approved: 'approval.tab.approved',
  rejected: 'approval.tab.rejected',
};

const confirmAction = confirmThen;

/** D12: how long the approval toast offers to take it back. */
const UNDO_APPROVE_MS = 5000;

export function ApprovalPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  // ORD-21 (2026-11): the card's total names the currency, as the
  // estimate in its detail does.
  const currency = useCurrency();
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // CA-43: the row version the reject sheet was opened on.
  const [rejectSeq, setRejectSeq] = useState<number | undefined>(undefined);
  // DX-APR-2 / DX-APR-3 (2026-11-01): orders whose 「通过」 waits — a
  // quantity not yet saved, or changes made by someone else since the
  // card was opened that the reviewer has not acknowledged.
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const onHold = useCallback((sessionId: string, hold: boolean) => {
    setHeld((prev) => {
      if (prev.has(sessionId) === hold) return prev;
      const next = new Set(prev);
      if (hold) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
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
  const online = useOnline();
  const toast = useToast();
  // Audit-found 2026-05-05: every mutation here used to onError ONLY haptic.
  // Manager taps Approve, network fails, they feel a buzz and assume "done"
  // since the toast they're used to never appears. Bad. Now every error
  // path surfaces a toast — domain errors get the i18n'd code translated;
  // unknown errors get the action's own failure sentence (DX-COPY-8).
  // M1.9 (2026-05-07): the regex and handler shape live in one place
  // (hooks/useErrToast.ts), so pages cannot drift apart.
  const errToast = useErrToast();
  const claim = trpc.order.claim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.claimed'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  // 2026-10-21 audit CA-43 "approve what you saw": approve / reject send
  // the `lastSeq` of the row on screen; the server answers CONFLICT
  // order.errors.staleSeq when the staff changed the order after that.
  // Then the card is out of date — reload it and say so, rather than
  // the generic "someone else just edited — retry" (a blind retry would
  // approve the new version unseen, which is the bug).
  const isOrderChanged = (err: unknown): boolean => conflictKind(err) === 'stale';
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
    decidedByMe.current.add(sessionId);
    approve.mutate(
      { sessionId, expectedSeq },
      { onSettled: () => approving.current.delete(sessionId) },
    );
  };
  // DX-APR-1 (2026-11-01): orders with a quantity change still on its way
  // (see approval/adjustInFlight.ts). Their 通过 / 驳回 wait for it.
  const adjustingIds = adjustingSessionIds(
    useMutationState({
      filters: { mutationKey: getMutationKey(trpc.order.adjustItem), status: 'pending' },
      select: (m) => m.state.variables,
    }),
  );
  const approve = trpc.order.approve.useMutation({
    onSuccess: (data, vars) => {
      // DX-IX-4 (2026-11-01): the approved card (and its button) leaves the
      // list; focus moves to the next card's title, not to <body>.
      void utils.order.pendingList.invalidate().then(() => focusAfter(NEXT_CARD));
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
      void utils.order.pendingList.invalidate().then(() => focusAfter(NEXT_CARD));
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
      errToast('common.errors.actionFailed')(err);
    },
  });
  const dates = useDateFormat();
  const releaseClaim = trpc.order.releaseClaim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.released'));
    },
    onError: errToast('common.errors.actionFailed'),
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
      errToast('common.errors.actionFailed')(err);
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
      errToast('common.errors.actionFailed')(err);
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
              owner: r.attribDisplayName ?? i18n.t('common.unknownMember'),
              who: r.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
            })
          : i18n.t('approval.toast.claimTimedOut', {
              owner: r.attribDisplayName ?? i18n.t('common.unknownMember'),
            }),
      );
    }
    myClaims.current = new Set(
      pendingQuery.data.filter((r) => me && r.claimedByMemberId === me).map((r) => r.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery.data, tab]);

  // DX-APR-3 (2026-11-01): the open card vanished from the queue without
  // this reviewer deciding it — say what happened (the submitter withdrew
  // it, or another reviewer decided it) instead of letting it disappear.
  const decidedByMe = useRef(new Set<string>());
  const lastPendingIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tab !== 'pending' || !pendingQuery.data) return;
    const ids = new Set(pendingQuery.data.map((r) => r.id));
    const openId = activeSessionId;
    if (openId && lastPendingIds.current.has(openId) && !ids.has(openId)) {
      if (!decidedByMe.current.delete(openId)) {
        void utils.order.sessionDetail.fetch({ sessionId: openId }).then(
          (d) => {
            haptic('warning');
            toast.show(
              d.status === 'draft'
                ? i18n.t('approval.toast.withdrawnWhileOpen')
                : i18n.t('approval.toast.decidedElsewhere'),
              { tone: 'info', ttlMs: 8000 },
            );
          },
          () => undefined,
        );
      }
    }
    lastPendingIds.current = ids;
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
        names: sku.names,
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
          <Tab value="pending">{i18n.t(TAB_LABEL_KEYS.pending)}</Tab>
          <Tab value="approved">{i18n.t(TAB_LABEL_KEYS.approved)}</Tab>
          <Tab value="rejected">{i18n.t(TAB_LABEL_KEYS.rejected)}</Tab>
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
                tab: i18n.t(TAB_LABEL_KEYS[tab]),
              })}
            />
          )
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list" data-approval-list="">
            {rows.map((row) => {
              const isClaimedByMe = row.claimedByMemberId === session.member.memberId;
              const adjusting = adjustingIds.has(row.id);
              const isClaimedByOther =
                row.claimedByMemberId && row.claimedByMemberId !== session.member.memberId;
              const isOpen = activeSessionId === row.id;
              const requests = cardRequests(row.notes, row.extrasJson);
              const canApproveRow = approvable(row.itemCount, requests.extras);
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
                          announced a person's face as "Store A", and a
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
                      {row.estimatedTotal &&
                      showPaymentSplit(row.estimatedCash, row.estimatedTransfer) ? (
                        <span
                          // V10: the figures in tabular digits, as the
                          // card's total beside them (UI-14).
                          data-testid="approval-payment-budget"
                          className="flex flex-col items-end text-old-label tabular-nums text-[var(--c-fg-muted)]"
                        >
                          <span className="whitespace-nowrap">
                            {i18n.t('run.label.paymentCash')}{' '}
                            <span className="tabular-nums">
                              ~{formatMoney(Number(row.estimatedCash))}
                            </span>
                          </span>
                          <span className="whitespace-nowrap">
                            {i18n.t('run.label.paymentTransfer')}{' '}
                            <span className="tabular-nums">
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
                        ELSE holds the claim). Claim stays for editing
                        quantities, and another approver's claim still hides
                        these buttons. While a claim or approval for this row
                        is in flight the other actions wait, so a quick
                        Claim → Approve can't race two writes onto the same
                        order stream (the loser would fail with staleSeq). */}
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
                    {tab === 'pending' && !row.claimedByMemberId ? (
                      <>
                        {canApproveRow ? (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={approve.isPending && approve.variables?.sessionId === row.id}
                          disabled={
                            !online ||
                            adjusting ||
                            held.has(row.id) ||
                            (claim.isPending && claim.variables?.sessionId === row.id)
                          }
                          onClick={() => approveOnce(row.id, row.lastSeq)}
                        >
                          {adjusting ? i18n.t('common.savingSlow') : i18n.t('approval.approve')}
                        </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={
                            !online ||
                            adjusting ||
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
                          disabled={!online || (approve.isPending && approve.variables?.sessionId === row.id)}
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
                        {canApproveRow ? (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={approve.isPending && approve.variables?.sessionId === row.id}
                          disabled={!online || adjusting || held.has(row.id)}
                          onClick={() => approveOnce(row.id, row.lastSeq)}
                        >
                          {adjusting ? i18n.t('common.savingSlow') : i18n.t('approval.approve')}
                        </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={!online || adjusting}
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
                          disabled={!online}
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
                        disabled={!online}
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
                        onHold={onHold}
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
              decidedByMe.current.add(rejectFor);
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
