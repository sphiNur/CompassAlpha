import { useState } from 'react';
import type { ReactNode } from 'react';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useStoreContext } from '../components/StoreSwitcher';
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
  /** In the summary card: what is counted. */
  label: string;
  count: number;
  /** In the prompt card under it. */
  body: string;
  action: string;
  icon: ReactNode;
  /** The small disc's colours in the summary grid. */
  disc: string;
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
 * main action at the top, a strip of quick actions, one large card that
 * sums up the day, a prompt for the most pressing thing, and what
 * happened lately.
 *
 * Only what is waiting is counted; a job with an empty queue has a quick
 * action to start it but no number.
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
      disc: 'bg-warning text-on-warning',
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
      disc: 'bg-primary text-on-primary',
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
      disc: 'bg-contrast text-on-contrast',
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
      disc: 'bg-contrast text-on-contrast',
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
      disc: 'bg-surface-sunken text-ink',
    });
  }

  // The strip of quick actions: every job this person does, the first one
  // in the accent colour.
  const quick: Array<{ key: string; label: string; tab: Tab }> = [];
  if (can('order.draft'))
    quick.push({ key: 'order', label: i18n.t('nav.order') as string, tab: 'order' });
  if (can('order.approve')) {
    quick.push({ key: 'approve', label: i18n.t('nav.approve') as string, tab: 'approve' });
  }
  if (can('run.purchase'))
    quick.push({ key: 'run', label: i18n.t('nav.run') as string, tab: 'run' });
  if (can('delivery.confirm')) {
    quick.push({ key: 'confirm', label: i18n.t('nav.confirm') as string, tab: 'confirm' });
  }

  const pressing = waiting.find((w) => w.key !== dismissed) ?? null;
  const offerOrder = !pressing && can('order.draft') && dismissed !== 'order';
  const batches = recent.data ?? [];

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

      {quick.length > 1 ? (
        <div className="-mx-page flex gap-md overflow-x-auto px-page">
          {quick.map((q, index) => (
            <button
              key={q.key}
              type="button"
              data-testid={`quick-${q.key}`}
              onClick={() => onOpen(q.tab)}
              className={
                'flex h-chip shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 ' +
                (index === 0 ? 'bg-primary text-on-primary' : 'bg-primary-pale text-forest')
              }
            >
              {q.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* The day in one card. */}
      <section data-testid="today-hero" className="flex flex-col gap-xl rounded-lg bg-surface p-xl">
        <div>
          <h1 className="text-h2 text-ink">{i18n.t('nav.today')}</h1>
          <p className="text-body text-secondary">
            {[i18n.t('today.summary', { n: waiting.length }), session?.member.orgName]
              .filter(Boolean)
              .join(' • ')}
          </p>
        </div>
        {waiting.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-lg gap-y-xl">
            {waiting.map((w) => (
              <button
                key={w.key}
                type="button"
                data-testid={`tile-${w.key}`}
                onClick={() => onOpen(w.tab)}
                className="flex min-w-0 items-center gap-md text-start outline-none active:opacity-60"
              >
                <span
                  aria-hidden
                  className={`flex size-disc shrink-0 items-center justify-center rounded-pill text-caption ${w.disc}`}
                >
                  {w.count}
                </span>
                <span className="min-w-0 flex-1 text-body text-ink">{w.label}</span>
                <span className="text-secondary">
                  <ChevronIcon />
                </span>
              </button>
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
