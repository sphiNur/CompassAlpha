import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet, Stepper } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n, useProductName, useUnitLabel } from '../hooks/useI18n';
import { haptic, usePageMainButton } from '../hooks/useTelegram';
import { confirmThen } from '../lib/confirm';
import { useErrToast } from '../lib/errToast';
import { currencyOf, formatMoney, formatQty } from '../lib/format';
import { useStoreContext } from '../components/StoreSwitcher';
import { ChevronIcon, ClockIcon } from '../destinations/icons';

type ApprovalTab = 'pending' | 'approved' | 'rejected';
const TABS: ApprovalTab[] = ['pending', 'approved', 'rejected'];

function firstLetter(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}

/**
 * Deciding on orders.
 *
 * There is a queue and there is one order. Opening an order is saying "I
 * am looking at this": it is claimed without a button, and given back
 * when the approver walks away from it. With a single order waiting,
 * which is most mornings, the queue is skipped and the order is what
 * opens. Approving moves on to the next one.
 *
 * Laid out after the Wise app: capsules for the three states, rows on
 * the page with a disc at the start, one large figure for the estimate.
 */
export function ApprovalPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  const currency = currencyOf(session);
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  // Once the approver has asked for the queue, a lone order no longer
  // opens by itself.
  const [wantsList, setWantsList] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const storeCtx = useStoreContext();
  // Looking at one store, the bar above already names it: the row leads
  // with who sent the order. Across stores, the store is what differs.
  const storeScoped = storeCtx.kind === 'specific';
  const me = session?.member.memberId;
  const can = (permission: string) => !!session?.permissions.includes(permission);

  const queue = trpc.order.pendingList.useQuery(
    {
      status: tab === 'pending' ? 'submitted' : tab,
      ...(storeCtx.kind === 'specific' ? { storeId: storeCtx.storeId } : {}),
    },
    { enabled: storeCtx.kind !== 'none', refetchOnMount: 'always' },
  );
  const rows = useMemo(() => queue.data ?? [], [queue.data]);
  const open = rows.find((r) => r.id === openId) ?? null;

  // The order this approver was asked to be given, and the one they hold.
  const asked = useRef<string | null>(null);
  const mine = useRef<string | null>(null);

  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const refresh = () => void utils.order.pendingList.invalidate();
  const claim = trpc.order.claim.useMutation({
    onSuccess: refresh,
    onError: errToast('common.error'),
  });
  const release = trpc.order.releaseClaim.useMutation({ onSuccess: refresh });
  const approve = trpc.order.approve.useMutation({
    onSuccess: (_data, input) => {
      haptic('success');
      toast.success(i18n.t('approval.toast.approved'));
      // On to the next one, if there is one.
      mine.current = null;
      setOpenId(rows.find((r) => r.id !== input.sessionId)?.id ?? null);
      refresh();
    },
    onError: errToast('approval.toast.approveFailed'),
  });
  const reject = trpc.order.reject.useMutation({
    onSuccess: (_data, input) => {
      haptic('warning');
      toast.info(i18n.t('approval.toast.rejected'));
      setRejecting(false);
      setReason('');
      mine.current = null;
      setOpenId(rows.find((r) => r.id !== input.sessionId)?.id ?? null);
      refresh();
    },
    onError: errToast('approval.toast.rejectFailed'),
  });
  const unapprove = trpc.order.unapprove.useMutation({
    onSuccess: () => {
      toast.info(i18n.t('approval.toast.unapproved'));
      setOpenId(null);
      refresh();
    },
    onError: errToast('common.error'),
  });

  // A lone waiting order opens by itself.
  useEffect(() => {
    if (tab === 'pending' && !wantsList && !openId && rows.length === 1) setOpenId(rows[0]!.id);
  }, [tab, wantsList, openId, rows]);

  // Opening a waiting order claims it. Asked once per order: if it fails,
  // the approver sees why and the order stays readable.
  const claimNow = claim.mutate;
  useEffect(() => {
    if (tab !== 'pending' || !open) return;
    if (open.claimedByMemberId === me) mine.current = open.id;
    if (!open.claimedByMemberId && asked.current !== open.id) {
      asked.current = open.id;
      claimNow({ sessionId: open.id });
    }
  }, [tab, open, me, claimNow]);

  // Walking away gives it back, so it does not sit claimed by someone
  // who is no longer looking.
  const releaseNow = release.mutate;
  const giveBack = () => {
    if (mine.current) releaseNow({ sessionId: mine.current });
    mine.current = null;
    asked.current = null;
  };
  const giveBackRef = useRef(giveBack);
  giveBackRef.current = giveBack;
  useEffect(() => () => giveBackRef.current(), []);

  const claimedByMe = !!open && open.claimedByMemberId === me;
  const claimedByOther = !!open && !!open.claimedByMemberId && open.claimedByMemberId !== me;
  const deciding = tab === 'pending' && !!open;

  usePageMainButton(
    i18n.t('approval.approve') as string,
    () => {
      if (open) approve.mutate({ sessionId: open.id });
    },
    {
      visible: deciding && !claimedByOther,
      active: claimedByMe && !approve.isPending && !reject.isPending,
      ...(open?.estimatedTotal && can('prices.view')
        ? {
            summary: {
              text: i18n.t('order.review.estimatedTotal') as string,
              amount: formatMoney(open.estimatedTotal),
              currency,
            },
          }
        : {}),
    },
  );

  if (!session) return null;

  const toList = () => {
    giveBack();
    setWantsList(true);
    setOpenId(null);
  };
  const who = (row: (typeof rows)[number]) =>
    row.attribDisplayName?.trim() || (i18n.t('approval.unknownReviewer') as string);
  const store = (row: (typeof rows)[number]) => row.storeName?.trim() || row.storeId.slice(0, 8);

  if (open) {
    const reviewer = open.claimedByDisplayName ?? (i18n.t('approval.unknownReviewer') as string);
    return (
      <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
        {rows.length > 1 || tab !== 'pending' ? (
          <button
            type="button"
            data-testid="approval-list"
            onClick={toList}
            className="flex h-chip items-center self-start rounded-pill bg-surface-sunken px-md text-caption text-ink outline-none active:opacity-60"
          >
            {i18n.t('approval.allOrders', { n: rows.length })}
          </button>
        ) : null}

        <header>
          <h1 className="text-h1 text-ink">{storeScoped ? who(open) : store(open)}</h1>
          <p className="text-body text-secondary">
            {[
              storeScoped ? null : who(open),
              open.orderDate,
              i18n.t('approval.itemsCount', { n: open.itemCount }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>

        {open.estimatedTotal && can('prices.view') ? (
          <div className="flex flex-col gap-xs">
            <span className="text-small text-secondary">
              {i18n.t('order.review.estimatedTotal')}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-sm text-ink" dir="ltr">
              <span className="text-display tabular-nums">{formatMoney(open.estimatedTotal)}</span>
              <span className="text-label text-secondary">{currency}</span>
            </span>
            <span className="text-small text-secondary">
              {i18n.t('order.review.estimateHint', {
                known: open.estimatedKnown,
                unknown: open.estimatedUnknown,
              })}
            </span>
          </div>
        ) : null}

        {tab === 'pending' && claimedByOther ? (
          <div
            role="status"
            className="flex flex-col items-start gap-md rounded-lg bg-warning-pale p-xl"
          >
            <p className="text-label text-warning-ink">
              {i18n.t('order.banner.claimed', { who: reviewer })}
            </p>
            <Button
              inline
              busy={release.isPending}
              onClick={() =>
                confirmThen(i18n.t('approval.confirmTakeover', { who: reviewer }) as string, () => {
                  asked.current = null;
                  release.mutate({ sessionId: open.id });
                })
              }
            >
              {i18n.t('approval.takeOver')}
            </Button>
          </div>
        ) : null}

        {open.status === 'rejected' ? (
          <div role="status" className="rounded-lg bg-danger-pale p-xl">
            <p className="text-body text-danger-ink">
              {open.rejectReason || i18n.t('order.status.rejectedNoReason')}
            </p>
          </div>
        ) : null}

        <OrderLines
          sessionId={open.id}
          storeId={open.storeId}
          editable={tab === 'pending' && claimedByMe}
          productName={productName}
        />

        {tab === 'pending' && claimedByMe ? (
          <Button
            variant="secondary"
            data-testid="approval-reject"
            disabled={approve.isPending}
            onClick={() => setRejecting(true)}
          >
            {i18n.t('approval.reject')}
          </Button>
        ) : null}
        {tab === 'approved' && can('order.unapprove') ? (
          <Button
            variant="secondary"
            busy={unapprove.isPending}
            onClick={() => unapprove.mutate({ sessionId: open.id })}
          >
            {i18n.t('approval.unapprove')}
          </Button>
        ) : null}

        <Sheet
          open={rejecting}
          // Stays open while the answer is on its way: a failed rejection
          // must not take the typed reason with it.
          onOpenChange={(next) => !next && !reject.isPending && setRejecting(false)}
          title={i18n.t('approval.confirm.reject.title') as string}
          actions={
            <Button
              variant="danger"
              data-testid="approval-reject-confirm"
              disabled={!reason.trim()}
              busy={reject.isPending}
              onClick={() => reject.mutate({ sessionId: open.id, reason: reason.trim() })}
            >
              {i18n.t('approval.reject')}
            </Button>
          }
        >
          <Field
            label={i18n.t('approval.confirm.reject.body') as string}
            value={reason}
            maxLength={500}
            placeholder={i18n.t('approval.confirm.reject.reasonPlaceholder') as string}
            onChange={(e) => setReason(e.target.value)}
          />
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
      <h1 className="text-h1 text-ink">{i18n.t('nav.approve')}</h1>

      <div
        role="tablist"
        aria-label={i18n.t('approval.tabsAriaLabel') as string}
        className="-mx-page flex gap-sm overflow-x-auto px-page"
      >
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-testid={`approval-tab-${key}`}
            onClick={() => {
              setTab(key);
              setOpenId(null);
              setWantsList(true);
            }}
            className={cn(
              'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70',
              tab === key ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
            )}
          >
            {i18n.t(`approval.tab.${key}`)}
          </button>
        ))}
      </div>

      {storeCtx.kind === 'none' ? (
        <div className="flex flex-col gap-xs">
          <h2 className="text-h2 text-ink">{i18n.t('auth.noStore.title')}</h2>
          <p className="text-body text-secondary">{i18n.t('auth.noStore.body')}</p>
        </div>
      ) : queue.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : queue.isError ? (
        <div className="flex flex-col items-start gap-md">
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
          <Button inline onClick={() => void queue.refetch()}>
            {i18n.t('common.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <div className="min-w-0">
            <h2 className="text-label text-ink">
              {tab === 'pending'
                ? i18n.t('approval.empty.title')
                : i18n.t('approval.empty.tab', { tab: i18n.t(`approval.tab.${tab}`) })}
            </h2>
            {tab === 'pending' ? (
              <p className="text-small text-secondary">{i18n.t('approval.empty.body')}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-lg">
          {rows.map((row) => {
            const lead = storeScoped ? who(row) : store(row);
            const busyWith =
              row.claimedByMemberId && row.claimedByMemberId !== me
                ? i18n.t('order.banner.claimed', {
                    who: row.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
                  })
                : null;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="approval-row"
                  onClick={() => setOpenId(row.id)}
                  className="flex w-full items-center gap-lg text-start outline-none active:opacity-60"
                >
                  <span
                    aria-hidden
                    className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink"
                  >
                    {firstLetter(lead)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">{lead}</span>
                    <span className="block text-small text-secondary">
                      {[
                        storeScoped ? null : who(row),
                        i18n.t('approval.itemsCount', { n: row.itemCount }),
                        row.orderDate,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {busyWith ? (
                      <span className="block text-small text-warning-ink">{busyWith}</span>
                    ) : null}
                    {row.status === 'rejected' ? (
                      <span className="block text-small text-danger">
                        {row.rejectReason || i18n.t('order.status.rejectedNoReason')}
                      </span>
                    ) : null}
                  </span>
                  {row.estimatedTotal && can('prices.view') ? (
                    <span className="shrink-0 text-money tabular-nums text-ink" dir="ltr">
                      {formatMoney(row.estimatedTotal)}{' '}
                      <span className="text-caption text-secondary">{currency}</span>
                    </span>
                  ) : null}
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * What an order asks for. The approver may change a quantity in place
 * while the order is theirs; the change is made in the name of whoever
 * asked, so the order does not go back to its author.
 */
function OrderLines({
  sessionId,
  storeId,
  editable,
  productName,
}: {
  sessionId: string;
  storeId: string;
  editable: boolean;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const detail = trpc.order.sessionDetail.useQuery({ sessionId });
  const skus = trpc.catalog.skus.useQuery({ includeArchived: false });
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const adjust = trpc.order.adjustItem.useMutation({
    onSuccess: () => {
      void utils.order.sessionDetail.invalidate({ sessionId });
      void utils.order.pendingList.invalidate();
    },
    onError: errToast('order.toast.adjustFailed'),
  });
  // Names for "who asked for how much". Only people who manage members
  // may read the list; without it the split is shown without names.
  const members = trpc.admin.memberList.useQuery(undefined, { enabled: editable, retry: false });

  if (detail.isPending) {
    return <p className="text-body text-secondary">{i18n.t('approval.items.loading')}</p>;
  }
  if (detail.isError) {
    return <p className="text-body text-danger">{i18n.t('approval.items.failed')}</p>;
  }

  const skuById = new Map((skus.data ?? []).map((sku) => [sku.id, sku]));
  const nameOf = new Map((members.data ?? []).map((m) => [m.memberId, m.displayName]));
  const totals = detail.data.totals.filter((t) => Number(t.qty) > 0);
  const asks = new Map<string, Array<{ contributorMemberId: string; qty: string }>>();
  for (const it of detail.data.items) {
    if (Number(it.qty) <= 0) continue;
    asks.set(it.skuId, [...(asks.get(it.skuId) ?? []), it]);
  }
  const extras = detail.data.extras ?? [];
  const notes = detail.data.notes ?? null;

  const stepper = (skuId: string, memberId: string, qty: string) => {
    const sku = skuById.get(skuId);
    if (!sku) return null;
    const step = Number(sku.step) || 1;
    const set = (next: number) =>
      adjust.mutate({
        storeId,
        // The order's own date: without it the server takes today, and an
        // order sent on an earlier day would be looked up on the wrong one.
        date: detail.data.orderDate,
        skuId,
        qty: String(Math.max(0, Math.round(next * 1000) / 1000)),
        targetMemberId: memberId,
      });
    return (
      <Stepper
        value={formatQty(qty)}
        unit={unitLabel(sku.unit)}
        disabled={adjust.isPending}
        onDecrement={() => set(Number(qty) - step)}
        onIncrement={() => set(Number(qty) + step)}
      />
    );
  };

  return (
    <div className="flex flex-col gap-xl">
      {extras.length > 0 || notes ? (
        <section className="flex flex-col gap-sm rounded-lg bg-warning-pale p-xl">
          <h2 className="text-label text-warning-ink">{i18n.t('order.extras.label')}</h2>
          {extras.map((e, index) => (
            <p
              key={`${e.name}-${index}`}
              className="flex justify-between gap-lg text-body text-ink"
            >
              <span className="min-w-0">{e.name}</span>
              <span className="shrink-0 tabular-nums" dir="ltr">
                {e.qty} {unitLabel(e.unit)}
              </span>
            </p>
          ))}
          {notes ? <p className="whitespace-pre-wrap text-body text-ink">{notes}</p> : null}
        </section>
      ) : null}

      {totals.length === 0 ? (
        <p className="text-body text-secondary">{i18n.t('common.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {totals.map((t) => {
            const sku = skuById.get(t.skuId);
            const name = sku
              ? productName({ names: sku.names as Record<string, string> })
              : t.skuId.slice(0, 8);
            const rows = asks.get(t.skuId) ?? [];
            const single = rows.length === 1 ? rows[0]! : null;
            const total = (
              <span className="text-money tabular-nums text-ink" dir="ltr">
                {formatQty(t.qty)} {unitLabel(sku?.unit ?? '')}
              </span>
            );
            return (
              <li key={t.skuId} data-testid="approval-line" className="flex flex-col gap-sm py-sm">
                <div className="flex min-h-row items-center gap-lg">
                  <span className="min-w-0 flex-1 text-label text-ink">{name}</span>
                  <span className="shrink-0">
                    {editable && single
                      ? (stepper(t.skuId, single.contributorMemberId, single.qty) ?? total)
                      : total}
                  </span>
                </div>
                {/* Several people asked: each one's share, each changeable. */}
                {rows.length > 1
                  ? rows.map((r) => (
                      <div
                        key={r.contributorMemberId}
                        className="flex items-center justify-between gap-lg ps-lg"
                      >
                        <span className="min-w-0 text-small text-secondary">
                          {nameOf.get(r.contributorMemberId) ?? r.contributorMemberId.slice(0, 6)}
                        </span>
                        <span className="shrink-0">
                          {editable ? (
                            stepper(t.skuId, r.contributorMemberId, r.qty)
                          ) : (
                            <span className="text-small tabular-nums text-secondary" dir="ltr">
                              {formatQty(r.qty)} {unitLabel(sku?.unit ?? '')}
                            </span>
                          )}
                        </span>
                      </div>
                    ))
                  : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
