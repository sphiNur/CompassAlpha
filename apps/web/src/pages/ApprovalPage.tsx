/**
 * ApprovalPage — manager queue.
 *
 * Lists submitted sessions enriched with store / member / item-count metadata
 * (single round-trip via `order.pendingList`). Atomically claim → review →
 * approve / reject. Per-card item view uses the dedicated
 * `order.sessionDetail({id})` endpoint.
 */
import { useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Input,
  PageHeader,
  QtyControl,
  Sheet,
  Spinner,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n, useProductName } from '../hooks/useI18n';
import { haptic } from '../hooks/useTelegram';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';
import { StoreSwitcher, useStoreContext } from '../components/StoreSwitcher';

type ApprovalTab = 'pending' | 'approved' | 'rejected';

export function ApprovalPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Store-context comes from the global header picker (added 2026-05-05).
  // Replaces the local chip-bar filter — same UX outcome but now the
  // selection follows the user across pages.
  //   'specific' → filter pendingList by that store
  //   'all'      → no filter (server still scopes to actor's allowed set)
  //   'none'     → user has no stores; refuse to query
  const storeCtx = useStoreContext();

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
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });

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
  const approve = trpc.order.approve.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      haptic('success');
      toast.success(i18n.t('approval.toast.approved'));
    },
    onError: errToast('approval.toast.approveFailed'),
  });
  const reject = trpc.order.reject.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      setRejectFor(null);
      setRejectReason('');
      haptic('warning');
      toast.info(i18n.t('approval.toast.rejected'));
    },
    onError: errToast('approval.toast.rejectFailed'),
  });
  const releaseClaim = trpc.order.releaseClaim.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.released'));
    },
    onError: errToast('common.error'),
  });
  const unapprove = trpc.order.unapprove.useMutation({
    onSuccess: () => {
      void utils.order.pendingList.invalidate();
      toast.info(i18n.t('approval.toast.unapproved'));
    },
    onError: errToast('common.error'),
  });

  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, { names: sku.names as Record<string, string>, unit: sku.unit });
    }
    return m;
  }, [skusQuery.data]);

  if (!session) return null;

  const count = pendingQuery.data?.length ?? null;

  // M1.9-extra (P4): adopted shared <PageHeader>. Subtitle pivots
  // between empty-tab message and a cardinal "X items" count.
  const subtitle =
    count === null
      ? ''
      : count === 0
        ? i18n.t('approval.empty.tab', { tab: i18n.t(`approval.tab.${tab}`) })
        : i18n.t('common.itemsCount', { n: count });

  return (
    <div className="flex flex-col">
      <PageHeader
        title={i18n.t('approval.title')}
        subtitle={subtitle}
        actions={<StoreSwitcher />}
      />

      <div className="sticky top-0 z-[1] border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-2">
        <ChipBar>
          <Chip selected={tab === 'pending'} onClick={() => setTab('pending')}>
            {i18n.t('approval.tab.pending')}
          </Chip>
          <Chip selected={tab === 'approved'} onClick={() => setTab('approved')}>
            {i18n.t('approval.tab.approved')}
          </Chip>
          <Chip selected={tab === 'rejected'} onClick={() => setTab('rejected')}>
            {i18n.t('approval.tab.rejected')}
          </Chip>
        </ChipBar>
      </div>

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
          <EmptyState
            title={i18n.t('approval.empty.title')}
            description={i18n.t('approval.empty.body')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((row) => {
              const isClaimedByMe = row.claimedByMemberId === session.member.memberId;
              const isClaimedByOther =
                row.claimedByMemberId && row.claimedByMemberId !== session.member.memberId;
              const isOpen = activeSessionId === row.id;
              return (
                <Card key={row.id}>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <Avatar
                        src={row.attribAvatarUrl}
                        name={row.storeName ?? row.attribDisplayName ?? '?'}
                        size={32}
                      />
                      <div>
                        <CardTitle>{row.storeName ?? row.storeId.slice(0, 8)}</CardTitle>
                        <CardMeta>
                          {/* Attribution = submitter (or initiator if not yet submitted).
                              M1.9-fix (2026-05-07): all 3 segments and the
                              timestamp locale were hardcoded; non-English
                              users saw English meta on every card. */}
                          {row.attribDisplayName
                            ? i18n.t('approval.submittedBy', { name: row.attribDisplayName })
                            : '—'}
                          {row.contributorCount > 1
                            ? ' · ' + i18n.t('approval.contributorsCount', { n: row.contributorCount })
                            : ''}
                          {' · '}
                          {row.orderDate}
                          {row.submittedAt
                            ? ' · ' +
                              new Date(row.submittedAt).toLocaleTimeString(i18n.locale, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : ''}
                        </CardMeta>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* "has notes" pill — surfaces a free-text request
                          before the manager has to expand the card.
                          Tone matches the highlighted block inside the
                          expanded view so the visual cue is consistent. */}
                      {row.notes ? (
                        <Badge tone="warn" title={i18n.t('order.notes.hasNote')}>
                          {i18n.t('order.notes.badge')}
                        </Badge>
                      ) : null}
                      <Badge status={row.status}>
                        {row.itemCount} · {row.totalQty}
                      </Badge>
                    </div>
                  </CardHeader>

                  {isClaimedByOther ? (
                    <div className="px-4 pt-2">
                      <Banner
                        tone="warn"
                        title={i18n.t('order.banner.claimed', { who: 'reviewer' })}
                      />
                    </div>
                  ) : null}

                  {row.status === 'rejected' ? (
                    <div className="px-4 pt-2">
                      {/* M1.7-fix (2026-05-07, audit CRITICAL #3): the
                          banner title was the literal "Draft" string,
                          a stale i18n key copy-paste from when this
                          card was reused for draft state. Use the new
                          `rejectedTitle` key (just "Rejected", no
                          interpolation) and keep the parameterized
                          `rejected` key for the body line. */}
                      {/* M1.9-fix (2026-05-07): the no-reason fallback
                          was using `approval.empty.body` ("New orders
                          awaiting review will appear here.") inside a
                          danger banner, which made zero sense. Use a
                          dedicated key. */}
                      <Banner
                        tone="danger"
                        title={i18n.t('order.status.rejectedTitle')}
                      >
                        {row.rejectReason
                          ? i18n.t('order.status.rejected', { reason: row.rejectReason })
                          : i18n.t('order.status.rejectedNoReason')}
                      </Banner>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-3">
                    {tab === 'pending' && !row.claimedByMemberId ? (
                      <Button
                        size="sm"
                        loading={claim.isPending && claim.variables?.sessionId === row.id}
                        onClick={() => {
                          claim.mutate({ sessionId: row.id });
                          setActiveSessionId(row.id);
                        }}
                      >
                        {i18n.t('approval.claim')}
                      </Button>
                    ) : null}
                    {tab === 'pending' && isClaimedByMe ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={approve.isPending && approve.variables?.sessionId === row.id}
                          onClick={() => approve.mutate({ sessionId: row.id })}
                        >
                          {i18n.t('approval.approve')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setRejectFor(row.id)}
                        >
                          {i18n.t('approval.reject')}
                        </Button>
                        <Button
                          size="sm"
                          variant="pearl"
                          onClick={() => releaseClaim.mutate({ sessionId: row.id })}
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
                        onClick={() => unapprove.mutate({ sessionId: row.id })}
                      >
                        {i18n.t('approval.unapprove')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setActiveSessionId(isOpen ? null : row.id)}
                    >
                      {isOpen ? i18n.t('approval.hideItems') : i18n.t('approval.viewItems')}
                    </Button>
                  </div>

                  {isOpen ? (
                    <SessionItems
                      sessionId={row.id}
                      storeId={row.storeId}
                      skuById={skuById}
                      productName={productName}
                      isClaimedByMe={isClaimedByMe}
                    />
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
          if (!open) {
            setRejectFor(null);
            setRejectReason('');
          }
        }}
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
              reject.mutate({ sessionId: rejectFor, reason: rejectReason.trim() });
            }}
          >
            {i18n.t('approval.reject')}
          </Button>
        }
      >
        <div className="py-3">
          <Input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={i18n.t('approval.confirm.reject.reasonPlaceholder')}
            maxLength={500}
          />
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
}: {
  sessionId: string;
  storeId: string;
  skuById: Map<string, { names: Record<string, string>; unit: string; step?: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  isClaimedByMe: boolean;
}) {
  const i18n = useI18n();
  const detail = trpc.order.sessionDetail.useQuery({ sessionId });
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const adjust = trpc.order.adjustItem.useMutation({
    onSuccess: () => {
      void utils.order.sessionDetail.invalidate({ sessionId });
      void utils.order.pendingList.invalidate();
    },
    onError: errToast('order.toast.adjustFailed'),
  });
  // Member directory lookup so we can show who contributed each row.
  const membersQuery = trpc.admin.memberList.useQuery(undefined, {
    // memberList requires users.manage. Managers usually have it; if not,
    // fall back to showing the bare member id instead of erroring.
    enabled: isClaimedByMe,
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
  const priceStats = trpc.catalog.skuPriceStats.useQuery(
    { skuIds: skuIdsForPrice },
    { enabled: skuIdsForPrice.length > 0, staleTime: 60_000 },
  );

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-[var(--c-divider)] px-4 py-3 text-body-sm text-[var(--c-fg-muted)]">
        <Spinner size={14} /> {i18n.t('approval.items.loading')}
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-body-sm text-[var(--c-danger)]">
        {i18n.t('approval.items.failed')}
      </div>
    );
  }
  const totals = (detail.data?.totals ?? []).filter((t) => Number(t.qty) > 0);
  const rawItems = detail.data?.items ?? [];
  const estimateTotal = (() => {
    let sum = 0;
    let known = 0;
    let unknown = 0;
    const priceMap = new Map(
      (priceStats.data ?? []).map((r) => [r.skuId, r.avg7d ?? r.lastPrice]),
    );
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
  if (totals.length === 0) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('common.empty')}
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

  const sessionNotes = detail.data?.notes ?? null;

  return (
    <div className="border-t border-[var(--c-divider)]">
    {/* Session-level "其他物品" note (M1.8). Shown right at the top
        so the manager can't miss requests for items outside the
        catalog before deciding to approve. Yellow highlight to call
        attention. Read-only here — manager can still bounce the order
        back to draft to edit. */}
    {sessionNotes ? (
      <div className="border-b border-[var(--c-divider)] bg-[var(--c-warn-bg)] px-4 py-3">
        <div className="text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
          {i18n.t('order.notes.label')}
        </div>
        <div className="mt-1 whitespace-pre-wrap text-body leading-snug text-[var(--c-fg)]">
          {sessionNotes}
        </div>
      </div>
    ) : null}
    {/* Estimated budget row (added 2026-05-05). Tells the manager
        roughly how much approval-then-purchase will cost, based on
        the last 7 days of price history. SKUs with no history skip
        and are flagged. */}
    {estimateTotal.known > 0 ? (
      <div className="flex items-baseline justify-between gap-2 px-4 py-2 text-label text-[var(--c-fg-muted)]">
        <span className="uppercase tracking-wide">
          {i18n.t('order.review.estimatedTotal')}
        </span>
        <span className="font-mono text-body font-semibold tabular-nums text-[var(--c-fg)]">
          ~{formatMoney(estimateTotal.sum)} UZS
        </span>
      </div>
    ) : null}
    <ul
      className="flex flex-col px-4 py-2"
      role="list"
    >
      {totals.map((t) => {
        const sku = skuById.get(t.skuId);
        const rows = rowsBySku.get(t.skuId) ?? [];
        return (
          <li key={t.skuId} className="border-b border-[var(--c-divider)] py-2 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2 text-body">
              <span className="truncate font-semibold text-[var(--c-fg)]">
                {sku ? productName(sku) : t.skuId.slice(0, 8)}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg)]">
                {formatQty(t.qty)} {sku?.unit ?? ''}
              </span>
            </div>
            {/* Contributor breakdown: only show when there are 2+ contributors,
                OR the manager has claimed (so they can edit in-place). */}
            {(rows.length > 1 || isClaimedByMe) ? (
              <ul className="mt-1 flex flex-col gap-1 pl-3" role="list">
                {rows.map((r) => (
                  <li
                    key={r.contributorMemberId}
                    className="flex items-center justify-between gap-2 text-label text-[var(--c-fg-muted)]"
                  >
                    <span className="truncate">
                      {memberById.get(r.contributorMemberId) ??
                        r.contributorMemberId.slice(0, 6)}
                    </span>
                    {isClaimedByMe && sku ? (
                      <QtyControl
                        size="sm"
                        value={Number(r.qty)}
                        step={Number(sku.step ?? '1')}
                        unit={sku.unit}
                        disabled={adjust.isPending}
                        onChange={(next) =>
                          adjust.mutate({
                            storeId,
                            skuId: t.skuId,
                            qty: String(next),
                            targetMemberId: r.contributorMemberId,
                          })
                        }
                      />
                    ) : (
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatQty(r.qty)} {sku?.unit ?? ''}
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
    </div>
  );
}

// ManagerLineEditor removed 2026-05-03: replaced by `<QtyControl size="sm">`
// from @compass/ui. The inline reimplementation drifted from the
// canonical +/- control's behavior (haptics, hold-to-repeat, manual
// entry sheet) — promoting to size="sm" gives ApprovalPage all of those
// behaviors for free, and any future improvements to QtyControl land
// here automatically.
