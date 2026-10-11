import { useState } from 'react';
import type { ReactNode } from 'react';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useStoreContext } from '../components/StoreSwitcher';
import { currencyOf, formatMoney } from '../lib/format';
import { useDay } from '../hooks/useDay';
import { StoreButton } from '../app/StoreBar';
import type { Tab } from '../stores/navStore';
import {
  useActiveRun,
  useCloseDue,
  useLinesToReceive,
  useOrdersToBuy,
  usePendingApprovals,
} from '../hooks/useWaitingCounts';
import {
  ApproveIcon,
  ChevronIcon,
  ClockIcon,
  CloseDayIcon,
  DismissIcon,
  OrdersIcon,
  PlusIcon,
  PurchasingIcon,
  ReceiveIcon,
} from './icons';

export interface TodayPageProps {
  onOpen: (tab: Tab) => void;
  onOpenSettings: () => void;
}

interface Waiting {
  key: 'approve' | 'receive' | 'run' | 'buy' | 'close';
  tab: Tab;
  /** What is waiting, in a few words. */
  label: string;
  count: number;
  /** In the prompt card under it. */
  body: string;
  action: string;
  icon: ReactNode;
}

function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2);
  // Not toUpperCase(): in Turkish that turns "i" into "İ". Names are shown
  // as written.
  return letters;
}

/**
 * The home screen, laid out after the Wise app's: who you are and the
 * main action at the top, a strip of this person's jobs, one large card
 * for the day, a prompt for the most pressing thing, and what happened
 * lately.
 *
 * The card answers what an owner opens the app to learn: what today has
 * cost and how far the buying has got. What is waiting is a number on
 * the job it belongs to, and one prompt for the first of them.
 */
export function TodayPage({ onOpen, onOpenSettings }: TodayPageProps) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const ctx = useStoreContext();
  const storeId = ctx.kind === 'specific' ? ctx.storeId : null;
  const [dismissed, setDismissed] = useState<string | null>(null);

  const toApprove = usePendingApprovals(can('order.approve'));
  const toBuy = useOrdersToBuy(can('run.purchase'));
  const activeRun = useActiveRun(can('run.purchase'));
  const toReceive = useLinesToReceive(can('delivery.confirm'));
  const closeDue = useCloseDue(can('settlement.record') && !!session?.member.dailyClose);
  const recent = trpc.order.todayBatches.useQuery(
    { storeId: storeId ?? '' },
    { enabled: can('order.draft') && !!storeId, refetchOnMount: 'always' },
  );

  const watchesBuying = can('run.purchase') || can('prices.view') || can('delivery.confirm');
  const day = useDay({ purchases: watchesBuying, prices: can('prices.view') });
  const currency = currencyOf(session);
  const closes = can('settlement.record') && !!session?.member.dailyClose;

  const waiting: Waiting[] = [];
  if (toApprove > 0) {
    waiting.push({
      key: 'approve',
      tab: 'approve',
      label: i18n.t('menu.tile.approve') as string,
      count: toApprove,
      body: i18n.t('today.promo.approveBody') as string,
      action: i18n.t('nav.approve') as string,
      icon: <ApproveIcon />,
    });
  }
  if (toReceive > 0) {
    waiting.push({
      key: 'receive',
      tab: 'confirm',
      label: i18n.t('today.delivery') as string,
      count: toReceive,
      body: i18n.t('today.promo.receiveBody') as string,
      action: i18n.t('nav.confirm') as string,
      icon: <ReceiveIcon />,
    });
  }
  if (activeRun) {
    waiting.push({
      key: 'run',
      tab: 'run',
      label: i18n.t('today.runInProgress') as string,
      count: 1,
      body: activeRun.runDate,
      action: i18n.t('today.continue') as string,
      icon: <PurchasingIcon />,
    });
  } else if (toBuy > 0) {
    waiting.push({
      key: 'buy',
      tab: 'run',
      label: i18n.t('menu.tile.buy') as string,
      count: toBuy,
      body: i18n.t('today.promo.buyBody') as string,
      action: i18n.t('nav.run') as string,
      icon: <PurchasingIcon />,
    });
  }
  if (closeDue === 1) {
    waiting.push({
      key: 'close',
      tab: 'settlement',
      label: i18n.t('menu.tile.close') as string,
      count: 1,
      body: i18n.t('today.promo.closeBody') as string,
      action: i18n.t('nav.settlement') as string,
      icon: <CloseDayIcon />,
    });
  }

  // The strip of quick actions: every job this person does, the first one
  // in the accent colour, each with the number waiting in it.
  const count = (key: Waiting['key']) => waiting.find((w) => w.key === key)?.count ?? 0;
  const quick: Array<{ key: string; label: string; tab: Tab; count: number }> = [];
  if (can('order.draft')) {
    quick.push({ key: 'order', label: i18n.t('nav.order') as string, tab: 'order', count: 0 });
  }
  if (can('order.approve')) {
    quick.push({
      key: 'approve',
      label: i18n.t('nav.approve') as string,
      tab: 'approve',
      count: count('approve'),
    });
  }
  if (can('run.purchase')) {
    quick.push({ key: 'run', label: i18n.t('nav.run') as string, tab: 'run', count: count('buy') });
  }
  if (can('delivery.confirm')) {
    quick.push({
      key: 'confirm',
      label: i18n.t('nav.confirm') as string,
      tab: 'confirm',
      count: count('receive'),
    });
  }
  if (closes) {
    quick.push({
      key: 'close',
      label: i18n.t('nav.settlement') as string,
      tab: 'settlement',
      count: count('close'),
    });
  }

  const pressing = waiting.find((w) => w.key !== dismissed) ?? null;
  const offerOrder = !pressing && can('order.draft') && dismissed !== 'order';
  const batches = recent.data ?? [];
  const ordered = batches.reduce((n, b) => n + b.itemCount, 0);

  return (
    <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
      {/* Who is signed in, the main action, and which store. */}
      <div className="flex items-center justify-between gap-md">
        <button
          type="button"
          data-testid="account"
          aria-label={i18n.t('menu.settings') as string}
          onClick={onOpenSettings}
          className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink outline-none active:opacity-60"
        >
          {initials(session?.user.displayName)}
        </button>
        {/* Two capsules side by side when they fit; a long store name or a
            long word for "New order" puts them on two lines instead of
            cutting either short. */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-md">
          {can('order.draft') ? (
            <button
              type="button"
              data-testid="today-new-order"
              onClick={() => onOpen('order')}
              className="flex h-pillbtn shrink-0 items-center rounded-pill bg-primary px-xl text-label text-on-primary outline-none active:bg-primary-pressed"
            >
              {i18n.t('orders.new')}
            </button>
          ) : null}
          <StoreButton pill />
        </div>
      </div>

      {quick.length > 1 || quick.some((q) => q.count > 0) ? (
        <div className="-mx-page flex gap-md overflow-x-auto px-page">
          {quick.map((q, index) => (
            <button
              key={q.key}
              type="button"
              data-testid={`quick-${q.key}`}
              data-count={q.count}
              onClick={() => onOpen(q.tab)}
              className={
                'flex h-chip shrink-0 items-center gap-sm rounded-pill px-lg text-label outline-none active:opacity-70 ' +
                (index === 0 ? 'bg-primary text-on-primary' : 'bg-primary-pale text-forest')
              }
            >
              {q.label}
              {q.count > 0 ? (
                <span className="rounded-pill bg-warning px-sm text-caption text-on-warning">
                  {q.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* The day in one card: what it has cost, and how far the buying is. */}
      <section data-testid="today-hero" className="flex flex-col gap-xl rounded-lg bg-surface p-xl">
        <div>
          <h1 className="text-h2 text-ink">{i18n.t('nav.today')}</h1>
          <p className="text-body text-secondary">{session?.member.orgName}</p>
        </div>

        {day.spend ? (
          <div data-testid="today-spend" className="flex flex-col gap-xs">
            <span className="text-small text-secondary">{i18n.t('today.spent')}</span>
            <span className="flex flex-wrap items-baseline gap-x-sm text-ink" dir="ltr">
              <span className="text-display tabular-nums">{formatMoney(day.spend.total)}</span>
              <span className="text-label text-secondary">{currency}</span>
            </span>
            {day.spend.total > 0 ? (
              <span className="text-small text-secondary">
                {i18n.t('run.label.paymentCash')}{' '}
                <span dir="ltr" className="tabular-nums text-ink">
                  {formatMoney(day.spend.cash)}
                </span>
                {' · '}
                {i18n.t('run.label.paymentTransfer')}{' '}
                <span dir="ltr" className="tabular-nums text-ink">
                  {formatMoney(day.spend.transfer)}
                </span>
              </span>
            ) : null}
          </div>
        ) : ordered > 0 ? (
          <div className="flex flex-col gap-xs">
            <span className="text-small text-secondary">{i18n.t('today.ordered')}</span>
            <span className="text-display text-ink">
              {i18n.t('run.label.itemsCount', { n: ordered })}
            </span>
          </div>
        ) : null}

        {day.progress ? (
          <button
            type="button"
            data-testid="today-progress"
            onClick={() => onOpen(can('run.purchase') ? 'run' : 'confirm')}
            className="flex flex-col gap-sm text-start outline-none active:opacity-60"
          >
            <span className="flex flex-wrap items-baseline justify-between gap-x-lg">
              <span className="text-label text-ink">
                {i18n.t(`run.status.${day.progress.status}` as Parameters<typeof i18n.t>[0])}
              </span>
              {day.progress.lines > 0 ? (
                <span className="text-small text-secondary">
                  {i18n.t('today.bought', { done: day.progress.done, lines: day.progress.lines })}
                </span>
              ) : null}
            </span>
            <span aria-hidden className="flex h-sm overflow-hidden rounded-pill bg-surface-sunken">
              <span
                className="rounded-pill bg-primary"
                style={{
                  width: `${day.progress.lines ? (day.progress.done / day.progress.lines) * 100 : 0}%`,
                }}
              />
            </span>
          </button>
        ) : watchesBuying ? (
          <p data-testid="today-buying" className="text-body text-secondary">
            {day.finished > 0
              ? i18n.t('today.buyingDone', { n: day.finished })
              : i18n.t('today.noBuying')}
          </p>
        ) : null}

        {/* Each store's share, when looking at all of them at once. */}
        {day.spend && storeId === null && day.spend.stores.length > 1 ? (
          <div className="grid grid-cols-2 gap-x-lg gap-y-xl">
            {day.spend.stores.map((st) => (
              <div key={st.storeId} data-testid="today-store" className="flex min-w-0 items-center gap-md">
                <span
                  aria-hidden
                  className="flex size-disc shrink-0 items-center justify-center rounded-pill bg-surface-sunken text-caption text-ink"
                >
                  {initials(st.name).slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-small text-secondary">{st.name}</span>
                  <span className="block text-money tabular-nums text-ink" dir="ltr">
                    {formatMoney(st.total)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {can('prices.view') || can('run.purchase') ? (
          <button
            type="button"
            data-testid="today-records"
            onClick={() => onOpen('purchasing')}
            className="flex h-chip items-center gap-sm self-start rounded-pill bg-surface-sunken px-md text-caption text-ink outline-none active:opacity-60"
          >
            {i18n.t('purchasing.past')}
          </button>
        ) : null}
      </section>

      {/* The one thing to do next, said in a sentence. */}
      {pressing || offerOrder ? (
        <section className="relative flex gap-lg rounded-lg bg-surface p-xl">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-ink"
          >
            {pressing ? pressing.icon : <PlusIcon />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-sm pe-xl">
            <div>
              <h2 className="text-label text-forest">
                {pressing ? pressing.label : i18n.t('today.promo.orderTitle')}
              </h2>
              <p className="text-small text-secondary">
                {pressing ? pressing.body : i18n.t('today.promo.orderBody')}
              </p>
            </div>
            <button
              type="button"
              data-testid={pressing ? `do-${pressing.key}` : 'do-order'}
              onClick={() => onOpen(pressing ? pressing.tab : 'order')}
              className="flex h-chip items-center rounded-pill bg-primary px-lg text-label text-on-primary outline-none active:bg-primary-pressed"
            >
              {pressing ? pressing.action : i18n.t('orders.new')}
            </button>
          </div>
          <button
            type="button"
            aria-label={i18n.t('today.dismiss') as string}
            onClick={() => setDismissed(pressing ? pressing.key : 'order')}
            className="absolute end-md top-md flex size-round items-center justify-center rounded-pill bg-surface-sunken text-ink outline-none active:opacity-60"
          >
            <DismissIcon />
          </button>
        </section>
      ) : null}

      {can('order.draft') ? (
        <section className="flex flex-col gap-lg">
          <div className="flex items-baseline justify-between gap-lg">
            <h2 className="text-h2 text-ink">{i18n.t('today.recent')}</h2>
            <button
              type="button"
              data-testid="today-see-all"
              onClick={() => onOpen('orders')}
              className="text-label text-forest underline underline-offset-4 outline-none active:opacity-60"
            >
              {i18n.t('today.seeAll')}
            </button>
          </div>
          {batches.length === 0 ? (
            <div className="flex items-center gap-lg">
              <span
                aria-hidden
                className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
              >
                <ClockIcon />
              </span>
              <span className="text-label text-secondary">{i18n.t('today.noRecent')}</span>
            </div>
          ) : (
            batches.map((b) => (
              <button
                key={b.id}
                type="button"
                data-testid="today-batch"
                onClick={() => onOpen('order')}
                className="flex items-center gap-lg text-start outline-none active:opacity-60"
              >
                <span
                  aria-hidden
                  className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-ink"
                >
                  <OrdersIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">
                    {i18n.t('order.batches.batchLabel', { n: b.batchNumber })}
                  </span>
                  <span className="block text-small text-secondary">
                    {[
                      i18n.t(`order.status.${b.status}` as Parameters<typeof i18n.t>[0], {
                        reason: '',
                      }),
                      i18n.t('run.label.itemsCount', { n: b.itemCount }),
                    ].join(' · ')}
                  </span>
                </span>
                <span className="text-forest">
                  <ChevronIcon />
                </span>
              </button>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}
