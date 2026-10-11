import { useEffect, useMemo, useState } from 'react';
import { cn } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useOrdersToBuy } from '../hooks/useWaitingCounts';
import { useDay } from '../hooks/useDay';
import { useStoreContext } from '../components/StoreSwitcher';
import { currencyOf, formatMoney } from '../lib/format';
import type { Tab } from '../stores/navStore';
import { PurchaseDetail } from './PurchaseDetail';
import type { PurchaseTarget } from './PurchaseDetail';
import { ChevronIcon, ClockIcon, PlusIcon, PurchasingIcon, SearchIcon } from './icons';

type Period = 'all' | 7 | 30;
// A purchase paid partly each way is its own kind: "cash" means all of it.
type Payment = 'all' | 'cash' | 'transfer' | 'mixed';
const PERIODS: Period[] = ['all', 7, 30];
const PAYMENTS: Payment[] = ['all', 'cash', 'transfer', 'mixed'];
const PAGE_SIZE = 20;

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function since(days: number): string {
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return localDate(start);
}

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';

/**
 * Buying, now and before, laid out after the Wise app's list of
 * transactions: the purchase under way or ready to start at the top,
 * then what earlier ones cost, a day at a time, a row per store.
 *
 * Narrowing is a strip of capsules and a search field, one tap each,
 * where it used to be a sheet with five controls. The store filter is
 * the store chosen at the top of the app.
 */
export function PurchasingPage({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const buyer = can('run.purchase');
  const prices = can('prices.view');
  const currency = currencyOf(session);
  const toBuy = useOrdersToBuy(buyer);
  const day = useDay({ purchases: buyer, prices: false });

  return (
    <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
      <h1 className="text-h1 text-ink">{i18n.t('nav.purchasing')}</h1>

      {buyer ? (
        day.progress ? (
          <section
            data-testid="purchasing-current"
            className="flex flex-col gap-lg rounded-lg bg-surface p-xl"
          >
            <div className="flex items-center gap-lg">
              <span
                aria-hidden
                className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
              >
                <PurchasingIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-label text-ink">
                  {i18n.t(`run.status.${day.progress.status}` as Parameters<typeof i18n.t>[0])}
                </span>
                {day.progress.lines > 0 ? (
                  <span className="block text-small text-secondary">
                    {i18n.t('today.bought', { done: day.progress.done, lines: day.progress.lines })}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                data-testid="open-run"
                onClick={() => onOpen('run')}
                className="flex h-pillbtn shrink-0 items-center rounded-pill bg-primary px-lg text-label text-on-primary outline-none active:bg-primary-pressed"
              >
                {i18n.t('today.continue')}
              </button>
            </div>
            <span aria-hidden className="flex h-sm overflow-hidden rounded-pill bg-surface-sunken">
              <span
                className="rounded-pill bg-primary"
                style={{
                  width: `${day.progress.lines ? (day.progress.done / day.progress.lines) * 100 : 0}%`,
                }}
              />
            </span>
          </section>
        ) : toBuy > 0 ? (
          <button
            type="button"
            data-testid="open-run"
            onClick={() => onOpen('run')}
            className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
          >
            <span
              aria-hidden
              className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
            >
              <PlusIcon />
            </span>
            <span data-testid="purchasing-current" className="min-w-0 flex-1">
              <span className="block text-label text-ink">{i18n.t('nav.run')}</span>
              <span className="block text-small text-secondary">
                {i18n.t('menu.tile.buy')} · {i18n.t('today.ordersCount', { n: toBuy })}
              </span>
            </span>
            <span className="shrink-0 text-forest">
              <ChevronIcon />
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-lg">
            <span
              aria-hidden
              className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
            >
              <ClockIcon />
            </span>
            <span className="text-label text-secondary">{i18n.t('purchasing.none')}</span>
          </div>
        )
      ) : null}

      {prices ? <PastPurchases currency={currency} /> : null}
    </div>
  );
}

function PastPurchases({ currency }: { currency: string }) {
  const i18n = useI18n();
  const ctx = useStoreContext();
  const storeId = ctx.kind === 'specific' ? ctx.storeId : undefined;
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const [payment, setPayment] = useState<Payment>('all');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<PurchaseTarget | null>(null);

  // Typing does not ask the server on every letter.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [typed]);
  useEffect(() => setPage(1), [search, period, payment, storeId]);

  // Everything narrows on the server, before it cuts the page: the phone
  // never downloads the whole ledger to filter it.
  const history = trpc.run.history.useQuery(
    {
      search: search || undefined,
      storeId,
      dateFrom: period === 'all' ? undefined : since(period),
      payment: payment === 'all' ? undefined : payment,
      sort: 'newest',
      page,
      pageSize: PAGE_SIZE,
    },
    { placeholderData: (previous) => previous, refetchOnMount: 'always' },
  );
  const stores = trpc.catalog.stores.useQuery({ permission: 'prices.view' });
  const storeById = useMemo(
    () => new Map((stores.data ?? []).map((st) => [st.id, st])),
    [stores.data],
  );

  const data = history.data;
  const rows = data?.rows ?? [];
  const narrowed = !!search || period !== 'all' || payment !== 'all';
  const info = data?.pageInfo;

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-x-lg">
        <h2 className="text-h2 text-ink">{i18n.t('purchasing.past')}</h2>
        {data && info && info.totalCount > 0 ? (
          <span data-testid="history-total" className="text-money tabular-nums text-ink" dir="ltr">
            {formatMoney(data.summary.total)}{' '}
            <span className="text-caption text-secondary">{currency}</span>
          </span>
        ) : null}
      </div>

      <label className="flex h-control items-center gap-md rounded-pill bg-field px-lg text-secondary ring-1 ring-inset ring-secondary focus-within:ring-2 focus-within:ring-ink">
        <SearchIcon />
        <input
          type="search"
          aria-label={i18n.t('run.history.searchPlaceholder') as string}
          placeholder={i18n.t('run.history.searchPlaceholder') as string}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-secondary"
        />
      </label>

      <div className="-mx-page flex gap-sm overflow-x-auto px-page">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            data-testid="history-period"
            onClick={() => setPeriod(p)}
            className={cn(
              CAPSULE,
              period === p ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
            )}
          >
            {p === 'all'
              ? i18n.t('order.categories.all')
              : i18n.t('run.history.lastDays', { n: p })}
          </button>
        ))}
        {PAYMENTS.filter((p) => p !== 'all').map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={payment === p}
            data-testid="history-payment"
            // A second tap takes the filter off again.
            onClick={() => setPayment(payment === p ? 'all' : p)}
            className={cn(
              CAPSULE,
              payment === p ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
            )}
          >
            {i18n.t(`run.history.payment.${p}` as Parameters<typeof i18n.t>[0])}
          </button>
        ))}
      </div>

      {history.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : history.isError ? (
        <div className="flex flex-col items-start gap-md">
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
          <button
            type="button"
            onClick={() => void history.refetch()}
            className={cn(CAPSULE, 'bg-surface-sunken text-ink')}
          >
            {i18n.t('common.retry')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <span className="text-label text-secondary">
            {narrowed ? i18n.t('run.history.noMatches') : i18n.t('purchasing.noPast')}
          </span>
        </div>
      ) : (
        <div className={cn('flex flex-col gap-xl', history.isFetching && 'opacity-60')}>
          {rows.map((run) => {
            const shares = run.storeTotals ?? [];
            return (
              <div key={run.id} data-testid="history-run" className="flex flex-col gap-md">
                {/* The day, quietly, with what it came to. */}
                <div className="flex items-baseline justify-between gap-lg text-body text-secondary">
                  <span>{run.runDate}</span>
                  {shares.length > 1 && run.actualTotal ? (
                    <span className="tabular-nums" dir="ltr">
                      {formatMoney(run.actualTotal)}
                    </span>
                  ) : null}
                </div>
                {shares.map((share) => {
                  const name =
                    storeById.get(share.storeId)?.name.trim() || share.storeId.slice(0, 8);
                  const how = [
                    Number(share.cash) > 0
                      ? `${i18n.t('run.history.payment.cash')} ${formatMoney(share.cash)}`
                      : null,
                    Number(share.transfer) > 0
                      ? `${i18n.t('run.history.payment.transfer')} ${formatMoney(share.transfer)}`
                      : null,
                  ].filter(Boolean);
                  return (
                    <button
                      key={share.storeId}
                      type="button"
                      data-testid="history-store"
                      onClick={() =>
                        setTarget({
                          runId: run.id,
                          runIndex: run.runIndex,
                          runDate: run.runDate,
                          storeId: share.storeId,
                        })
                      }
                      className="flex items-center gap-lg text-start outline-none active:opacity-60"
                    >
                      <span
                        aria-hidden
                        className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink"
                      >
                        {Array.from(name)[0]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-label text-ink">{name}</span>
                        <span className="block text-small text-secondary">
                          {[i18n.t('approval.itemsCount', { n: share.itemCount }), ...how].join(
                            ' · ',
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-money tabular-nums text-ink" dir="ltr">
                        {formatMoney(share.total)}
                      </span>
                      <span className="shrink-0 text-forest">
                        <ChevronIcon />
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {info && info.totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-md">
          <span className="text-small text-secondary">
            {i18n.t('run.history.resultRange', {
              from: (info.page - 1) * info.pageSize + 1,
              to: Math.min(info.page * info.pageSize, info.totalCount),
              total: info.totalCount,
            })}
          </span>
          <div className="flex gap-sm">
            <button
              type="button"
              disabled={!info.hasPrevious}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              className={cn(CAPSULE, 'bg-surface-sunken text-ink disabled:opacity-40')}
            >
              {i18n.t('run.history.previousPage')}
            </button>
            <button
              type="button"
              disabled={!info.hasNext}
              onClick={() => setPage((n) => n + 1)}
              className={cn(CAPSULE, 'bg-surface-sunken text-ink disabled:opacity-40')}
            >
              {i18n.t('run.history.nextPage')}
            </button>
          </div>
        </div>
      ) : null}

      <PurchaseDetail target={target} onClose={() => setTarget(null)} />
    </section>
  );
}
