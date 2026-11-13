/**
 * ApprovalPage — manager queue.
 *
 * Lists submitted sessions enriched with store / member / item-count metadata
 * (single round-trip via `order.pendingList`). Review → approve / reject;
 * the first quantity change claims the order (V1: no separate claim
 * step). Per-card item view uses the dedicated `order.sessionDetail({id})`
 * endpoint.
 *
 * Review ORD-10 (2026-11, step 2): each order is an ApprovalCard
 * (approval/ApprovalCard.tsx); the page keeps the writes and what
 * follows them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutationState } from '@tanstack/react-query';
import { getMutationKey } from '@trpc/react-query';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Segmented,
  Sheet,
  StickyPageBar,
  focusAfter,
  useToast,
} from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { haptic } from '../lib/telegram';
import { useOnline } from '../hooks/useOnline';
import { useErrToast } from '../hooks/useErrToast';
import { useStableCallbacks } from '../hooks/useStableCallbacks';
import { hasStorePermission } from '../lib/storePermission';
import { useStoreContext } from '../hooks/useStoreContext';
import { adjustingSessionIds } from './approval/adjustInFlight';
import { conflictKind } from '../lib/conflict';
import { ApprovalCard, type ApprovalCardBusy, type ApprovalTab } from './approval/ApprovalCard';

/** DX-IX-4: where focus goes after a card is decided (the list's first card title). */
const NEXT_CARD = '[data-approval-list] > li h2';

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

/** D12: how long the approval toast offers to take it back. */
const UNDO_APPROVE_MS = 5000;

export function ApprovalPage() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
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
  // after "approved". One in flight per order, with the order's store
  // (ORD-28: whether its approval may be undone is that store's rule);
  // approve's onSuccess runs before the entry is let go.
  const approving = useRef(new Map<string, string>());
  const approveOnce = (sessionId: string, storeId: string, expectedSeq: number) => {
    if (approving.current.has(sessionId)) return;
    approving.current.set(sessionId, storeId);
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
      // anyone else has touched the order. Review ORD-28 (2026-11): in
      // the order's store, as the server decides it; the flat list said
      // yes for a manager of another store.
      if (!hasStorePermission(session, approving.current.get(vars.sessionId), 'order.unapprove')) {
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
  // Review ORD-31 (2026-11): this and the next effect run when the queue
  // or the tab changes; what else they read comes from the latest render
  // (useStableCallbacks) instead of past a silenced dependency lint.
  const { noticeLostClaims } = useStableCallbacks({
    noticeLostClaims: () => {
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
    },
  });
  useEffect(() => {
    noticeLostClaims();
  }, [noticeLostClaims, pendingQuery.data, tab]);

  // DX-APR-3 (2026-11-01): the open card vanished from the queue without
  // this reviewer deciding it — say what happened (the submitter withdrew
  // it, or another reviewer decided it) instead of letting it disappear.
  const decidedByMe = useRef(new Set<string>());
  const lastPendingIds = useRef<Set<string>>(new Set());
  const { noticeVanishedCard } = useStableCallbacks({
    noticeVanishedCard: () => {
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
    },
  });
  useEffect(() => {
    noticeVanishedCard();
  }, [noticeVanishedCard, pendingQuery.data, tab]);

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

  /** Which of a card's writes is on its way. */
  const busyFor = (sessionId: string): ApprovalCardBusy => ({
    approving: approve.isPending && approve.variables?.sessionId === sessionId,
    takingOver: takeOverClaim.isPending && takeOverClaim.variables?.sessionId === sessionId,
    releasing: releaseClaim.isPending && releaseClaim.variables?.sessionId === sessionId,
    unapproving: unapprove.isPending && unapprove.variables?.sessionId === sessionId,
  });

  if (!session) return null;

  // M1.11 cleanup (2026-05-08): subtitle dropped — the status switch
  // immediately below + the empty-state Card (when count===0) +
  // the Card list itself already convey "what state am I in" and
  // "how many". The redundant "X items" line just compressed the
  // SKU list further.
  return (
    <div className="flex flex-col">
      {/* M3.5: store-switcher pill moved to SettingsSheet. The sticky
         band now only carries the approval-state switch. */}
      <StickyPageBar direction="col">
        {/* 2026-07-30: which store's queue am I looking at? The list is
            filtered by store context but never said so. On 'all' the chip
            reads 所有门店, which is equally load-bearing. Answered by the
            chip in Shell's top strip now (same day) rather than a copy
            per page — this strip is back to just the state switch. */}
        {/* Review ORD-22 (2026-11): the kit's Segmented, as every other
            page switches its views (UI-16); this was the one <Tabs> in
            the app. One Tab stop, arrow keys between the states. */}
        <Segmented<ApprovalTab>
          value={tab}
          onChange={setTab}
          ariaLabel={i18n.t('approval.tabsAriaLabel')}
          options={[
            { value: 'pending', label: i18n.t(TAB_LABEL_KEYS.pending) },
            { value: 'approved', label: i18n.t(TAB_LABEL_KEYS.approved) },
            { value: 'rejected', label: i18n.t(TAB_LABEL_KEYS.rejected) },
          ]}
        />
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
            {rows.map((row) => (
              <ApprovalCard
                key={row.id}
                row={row}
                session={session}
                tab={tab}
                storeScoped={storeScoped}
                // APR-15 (2026-10-30): two cards from one person on one day
                // were indistinguishable; only then the submit time tells
                // them apart.
                showSubmitTime={rows.some(
                  (o) =>
                    o.id !== row.id &&
                    o.orderDate === row.orderDate &&
                    o.attribDisplayName === row.attribDisplayName,
                )}
                online={online}
                adjusting={adjustingIds.has(row.id)}
                held={held.has(row.id)}
                open={activeSessionId === row.id}
                busy={busyFor(row.id)}
                skuById={skuById}
                onHold={onHold}
                onApprove={() => approveOnce(row.id, row.storeId, row.lastSeq)}
                onReject={() => {
                  setRejectFor(row.id);
                  setRejectSeq(row.lastSeq);
                }}
                onRelease={() => {
                  letGo.current.add(row.id);
                  releaseClaim.mutate({ sessionId: row.id });
                }}
                onTakeOver={() =>
                  takeOverClaim.mutate({
                    sessionId: row.id,
                    // RE-APR-2: take over this claim, no other.
                    fromMemberId: row.claimedByMemberId ?? undefined,
                  })
                }
                onUnapprove={() => unapprove.mutate({ sessionId: row.id })}
                onToggleItems={() =>
                  setActiveSessionId(activeSessionId === row.id ? null : row.id)
                }
              />
            ))}
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
