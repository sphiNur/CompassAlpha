import type { ReactNode } from 'react';
import { StatusChip } from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useStoreContext } from '../components/StoreSwitcher';
import { currencyOf, formatMoney } from '../lib/format';
import type { Tab } from '../stores/navStore';
import { ChevronIcon, ClockIcon, OrdersIcon, PlusIcon } from './icons';

const TONE: Record<string, StatusTone> = {
  draft: 'neutral',
  submitted: 'pending',
  approved: 'done',
  in_run: 'done',
  rejected: 'problem',
  archived: 'neutral',
};

/**
 * A row as the Wise app draws one: a disc, a heavy line over a quiet
 * one, and whatever belongs at the far end. It sits on the page itself,
 * not in a card.
 */
function DiscRow({
  disc,
  filled = false,
  title,
  detail,
  end,
  onPress,
  ...rest
}: {
  disc: ReactNode;
  /** A filled disc is a person or a store; an outlined one is a thing. */
  filled?: boolean;
  title: ReactNode;
  detail?: ReactNode;
  end?: ReactNode;
  onPress: () => void;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex items-center gap-lg text-start outline-none active:opacity-60"
      {...rest}
    >
      <span
        aria-hidden
        className={
          'flex size-avatar shrink-0 items-center justify-center rounded-pill text-label text-ink ' +
          (filled ? 'bg-surface' : 'border border-line')
        }
      >
        {disc}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-label text-ink">{title}</span>
        {detail ? <span className="block text-small text-secondary">{detail}</span> : null}
      </span>
      {end ? <span className="flex shrink-0 flex-col items-end gap-xs">{end}</span> : null}
      <span className="shrink-0 text-forest">
        <ChevronIcon />
      </span>
    </button>
  );
}

/**
 * The store's orders, laid out after the Wise app's Payments screen: the
 * thing you can start is a card with a dashed edge at the top, and under
 * it what exists already, as rows. First the orders waiting for a
 * decision, for someone who decides; then today's own, with where each
 * has got to.
 */
export function OrdersPage({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const ctx = useStoreContext();
  const storeId = ctx.kind === 'specific' ? ctx.storeId : null;
  const currency = currencyOf(session);

  const pending = trpc.order.pendingList.useQuery(
    { status: 'submitted', ...(storeId ? { storeId } : {}) },
    { enabled: can('order.approve') && ctx.kind !== 'none', refetchOnMount: 'always' },
  );
  const mine = trpc.order.todayBatches.useQuery(
    { storeId: storeId ?? '' },
    { enabled: can('order.draft') && !!storeId, refetchOnMount: 'always' },
  );

  const waiting = pending.data ?? [];
  const batches = mine.data ?? [];
  const mayOrder = can('order.draft');

  return (
    <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
      <h1 className="text-h1 text-ink">{i18n.t('nav.orders')}</h1>

      {/* What can be started here. A dashed edge says "not there yet". */}
      {mayOrder ? (
        <button
          type="button"
          data-testid="orders-new"
          disabled={!storeId}
          onClick={() => onOpen('order')}
          className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60 disabled:opacity-50"
        >
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
          >
            <PlusIcon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-label text-ink">{i18n.t('orders.new')}</span>
            <span className="block text-small text-secondary">
              {storeId ? i18n.t('today.promo.orderBody') : i18n.t('storeSwitcher.pickPrompt.body')}
            </span>
          </span>
          <span className="shrink-0 text-forest">
            <ChevronIcon />
          </span>
        </button>
      ) : null}

      {waiting.length > 0 ? (
        <section className="flex flex-col gap-lg">
          <h2 className="text-h2 text-ink">{i18n.t('menu.tile.approve')}</h2>
          {waiting.map((row) => {
            const name = row.storeName?.trim() || row.storeId.slice(0, 8);
            return (
              <DiscRow
                key={row.id}
                data-testid="orders-pending"
                filled
                disc={name.slice(0, 1)}
                title={name}
                detail={[
                  row.attribDisplayName?.trim(),
                  i18n.t('approval.itemsCount', { n: row.itemCount }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                end={
                  can('prices.view') && row.estimatedTotal ? (
                    <span className="text-money tabular-nums text-ink" dir="ltr">
                      {formatMoney(row.estimatedTotal)}{' '}
                      <span className="text-caption text-secondary">{currency}</span>
                    </span>
                  ) : undefined
                }
                onPress={() => onOpen('approve')}
              />
            );
          })}
        </section>
      ) : null}

      {mayOrder && storeId ? (
        <section className="flex flex-col gap-lg">
          <h2 className="text-h2 text-ink">{i18n.t('orders.today')}</h2>
          {batches.length === 0 ? (
            <div className="flex items-center gap-lg">
              <span
                aria-hidden
                className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
              >
                <ClockIcon />
              </span>
              <span className="text-label text-secondary">{i18n.t('orders.none')}</span>
            </div>
          ) : (
            batches.map((b) => (
              <DiscRow
                key={b.id}
                data-testid="orders-batch"
                disc={<OrdersIcon />}
                title={i18n.t('order.batches.batchLabel', { n: b.batchNumber })}
                detail={i18n.t('approval.itemsCount', { n: b.itemCount })}
                end={
                  <StatusChip tone={TONE[b.status] ?? 'neutral'}>
                    {i18n.t(`order.status.${b.status}` as Parameters<typeof i18n.t>[0], {
                      reason: '',
                    })}
                  </StatusChip>
                }
                onPress={() => onOpen('order')}
              />
            ))
          )}
        </section>
      ) : null}

      {!mayOrder && waiting.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <span className="text-label text-secondary">{i18n.t('orders.none')}</span>
        </div>
      ) : null}
    </div>
  );
}
