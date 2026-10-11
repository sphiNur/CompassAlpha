import { useMemo, useState } from 'react';
import { cn, Sheet, StatusChip } from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { PAGE_SIZE } from '../../config/timings';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { matchesNameLike, normalizeQuery } from '../../lib/searchMatch';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../../hooks/useI18n';
import { currencyOf, formatMoney } from '../../lib/format';
import { ChevronIcon, ClockIcon, SearchIcon } from '../icons';

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

function Nothing({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-lg">
      <span
        aria-hidden
        className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
      >
        <ClockIcon />
      </span>
      <span className="min-w-0">
        <span className="block text-label text-secondary">{title}</span>
        {hint ? <span className="block text-small text-secondary">{hint}</span> : null}
      </span>
    </div>
  );
}

type Moved = 'all' | 'up' | 'down';
// A change smaller than this against the month's average is the market
// breathing, not news.
const NOTABLE = 5;

/**
 * What things cost: the last price paid for each product against its
 * average over thirty days. What went up most is at the top, because
 * that is what an owner opens this to find; a change under five per
 * cent is not marked at all.
 */
export function PricesScreen() {
  const i18n = useI18n();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const currency = currencyOf(useAuthStore((s) => s.session));
  const skus = trpc.catalog.skus.useQuery({ includeArchived: false });
  const stats = trpc.catalog.skuPriceStats.useQuery();
  const [typed, setTyped] = useState('');
  const [moved, setMoved] = useState<Moved>('all');

  const rows = useMemo(() => {
    const skuById = new Map((skus.data ?? []).map((s) => [s.id, s]));
    return (stats.data ?? [])
      .map((r) => {
        const sku = skuById.get(r.skuId);
        const last = r.lastPrice ? Number(r.lastPrice) : null;
        const month = r.avg30d ? Number(r.avg30d) : null;
        return {
          skuId: r.skuId,
          names: (sku?.names ?? null) as Record<string, string> | null,
          code: sku?.code ?? null,
          unit: sku?.unit ?? '',
          last,
          week: r.avg7d ? Number(r.avg7d) : null,
          month,
          times: r.observations30d,
          change: last !== null && month ? ((last - month) / month) * 100 : null,
        };
      })
      .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity));
  }, [skus.data, stats.data]);

  const tokens = normalizeQuery(typed);
  const shown = rows.filter(
    (r) =>
      (moved === 'all' ||
        (moved === 'up' ? (r.change ?? 0) >= NOTABLE : (r.change ?? 0) <= -NOTABLE)) &&
      (!tokens || matchesNameLike({ names: r.names, code: r.code }, tokens)),
  );

  return (
    <div className="flex flex-col gap-xl px-page">
      <p className="text-body text-secondary">{i18n.t('prices.how')}</p>

      <div className="flex flex-col gap-lg">
        <label className="flex h-control items-center gap-md rounded-pill bg-field px-lg text-secondary ring-1 ring-inset ring-secondary focus-within:ring-2 focus-within:ring-ink">
          <SearchIcon />
          <input
            type="search"
            aria-label={i18n.t('order.search.placeholder') as string}
            placeholder={i18n.t('order.search.placeholder') as string}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-secondary"
          />
        </label>
        <div className="flex flex-wrap gap-sm">
          {(['all', 'up', 'down'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={moved === m}
              data-testid="prices-moved"
              onClick={() => setMoved(m)}
              className={pick(moved === m)}
            >
              {i18n.t(m === 'all' ? 'order.categories.all' : `prices.${m}`)}
            </button>
          ))}
        </div>
      </div>

      {stats.isPending || skus.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : stats.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : rows.length === 0 ? (
        <Nothing
          title={i18n.t('ops.price.emptyTitle') as string}
          hint={i18n.t('ops.price.emptyBody') as string}
        />
      ) : shown.length === 0 ? (
        <Nothing title={i18n.t('admin.search.noMatches.title') as string} />
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => {
            const notable = r.change !== null && Math.abs(r.change) >= NOTABLE;
            return (
              <li
                key={r.skuId}
                data-testid="prices-row"
                className="flex min-h-row items-center gap-lg py-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">
                    {r.names ? productName({ names: r.names }) : r.skuId.slice(0, 8)}
                  </span>
                  <span className="block text-small text-secondary">
                    {[
                      r.week !== null
                        ? i18n.t('prices.week', { price: formatMoney(r.week) })
                        : null,
                      r.month !== null
                        ? i18n.t('prices.month', { price: formatMoney(r.month) })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-xs">
                  <span className="text-money tabular-nums text-ink" dir="ltr">
                    {r.last !== null ? formatMoney(r.last) : ''}{' '}
                    <span className="text-caption text-secondary">
                      {currency} / {unitLabel(r.unit)}
                    </span>
                  </span>
                  {/* Dearer is the problem; cheaper is good news. */}
                  {notable ? (
                    <StatusChip tone={r.change! > 0 ? 'problem' : 'done'}>
                      <span dir="ltr">
                        {r.change! > 0 ? '+' : '−'}
                        {Math.abs(r.change!).toFixed(0)}%
                      </span>
                    </StatusChip>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const TONE: Record<string, StatusTone> = {
  submitted: 'pending',
  approved: 'done',
  in_run: 'done',
  archived: 'neutral',
  rejected: 'problem',
  draft: 'neutral',
};

/**
 * Every order that was sent, newest first: which store, who sent it,
 * and what became of it. A row opens to who decided and how long it
 * took, and to who asked for how much when several people ordered
 * together.
 */
export function OrderHistoryScreen() {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const stores = trpc.admin.storeList.useQuery();
  const history = trpc.admin.submissionHistory.useQuery({
    storeId: storeId ?? undefined,
    limit: PAGE_SIZE.list,
  });

  const status = (s: string) =>
    i18n.t(
      `order.status.${s === 'rejected' ? 'rejectedTitle' : s}` as Parameters<typeof i18n.t>[0],
      { reason: '' },
    );
  const open = history.data?.find((r) => r.sessionId === openId) ?? null;

  return (
    <div className="flex flex-col gap-xl px-page">
      <div className="-mx-page flex gap-sm overflow-x-auto px-page">
        {[null, ...(stores.data ?? []).map((st) => st.id)].map((id) => (
          <button
            key={id ?? 'all'}
            type="button"
            aria-pressed={storeId === id}
            data-testid="history-store-filter"
            onClick={() => setStoreId(id)}
            className={pick(storeId === id)}
          >
            {id
              ? (stores.data?.find((st) => st.id === id)?.name ?? '')
              : i18n.t('run.history.allStores')}
          </button>
        ))}
      </div>

      {history.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : history.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : history.data.length === 0 ? (
        <Nothing
          title={i18n.t('ops.history.emptyTitle') as string}
          hint={i18n.t('ops.history.emptyBody') as string}
        />
      ) : (
        <ul className="flex flex-col">
          {history.data.map((r) => {
            const name = r.storeName?.trim() || r.storeId.slice(0, 8);
            return (
              <li key={r.sessionId}>
                <button
                  type="button"
                  data-testid="order-history-row"
                  onClick={() => setOpenId(r.sessionId)}
                  className="flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60"
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
                      {[
                        r.orderDate,
                        r.submittedByName,
                        i18n.t('approval.itemsCount', { n: r.skuCount }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <StatusChip tone={TONE[r.status] ?? 'neutral'}>{status(r.status)}</StatusChip>
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={!!open}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={open ? open.storeName?.trim() || open.storeId.slice(0, 8) : ''}
      >
        {open ? (
          <div className="flex flex-col gap-xl">
            <div className="flex flex-col gap-xs">
              <StatusChip tone={TONE[open.status] ?? 'neutral'} className="self-start">
                {status(open.status)}
              </StatusChip>
              <span className="text-body text-secondary">
                {[
                  open.orderDate,
                  open.submittedByName
                    ? i18n.t('history.sentBy', { name: open.submittedByName })
                    : null,
                  open.submittedAt ? dateFmt.time(open.submittedAt) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {open.decidedByName ? (
                <span className="text-body text-secondary">
                  {[
                    i18n.t('history.decidedBy', { name: open.decidedByName }),
                    open.reviewMinutes !== null
                      ? i18n.t('history.took', { n: open.reviewMinutes })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : null}
            </div>

            {open.rejectReason ? (
              <p role="status" className="rounded-lg bg-danger-pale p-xl text-body text-danger-ink">
                {open.rejectReason}
              </p>
            ) : null}

            <section className="flex flex-col gap-sm">
              <h3 className="text-body text-secondary">
                {i18n.t('ops.history.contributorBreakdown')}
              </h3>
              {open.contributors.map((c) => (
                <div
                  key={c.memberId}
                  data-testid="order-history-person"
                  className="flex min-h-row items-center gap-lg"
                >
                  <span className="min-w-0 flex-1 text-label text-ink">
                    {c.displayName ?? c.memberId.slice(0, 6)}
                  </span>
                  <span className="shrink-0 text-body text-secondary">
                    {i18n.t('approval.itemsCount', { n: c.skuCount })}
                  </span>
                </div>
              ))}
            </section>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
