import { EmptyState, List, Row, Section, StatusChip } from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { usePageMainButton } from '../hooks/useTelegram';
import { useStoreContext } from '../components/StoreSwitcher';
import type { Tab } from '../stores/navStore';

const TONE: Record<string, StatusTone> = {
  draft: 'neutral',
  submitted: 'pending',
  approved: 'done',
  in_run: 'done',
  rejected: 'problem',
  archived: 'neutral',
};

/**
 * The store's orders: the ones waiting for a decision, for someone who
 * decides, and today's own, with where each has got to. Starting a new
 * order is the screen's one button.
 */
export function OrdersPage({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const ctx = useStoreContext();
  const storeId = ctx.kind === 'specific' ? ctx.storeId : null;

  const pending = trpc.order.pendingList.useQuery(
    { status: 'submitted', ...(storeId ? { storeId } : {}) },
    { enabled: can('order.approve') && ctx.kind !== 'none', refetchOnMount: 'always' },
  );
  const mine = trpc.order.todayBatches.useQuery(
    { storeId: storeId ?? '' },
    { enabled: can('order.draft') && !!storeId, refetchOnMount: 'always' },
  );

  usePageMainButton(i18n.t('orders.new') as string, () => onOpen('order'), {
    visible: can('order.draft') && !!storeId,
  });

  const waiting = pending.data ?? [];
  const batches = mine.data ?? [];

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      <header>
        <h1 className="text-h1 text-ink">{i18n.t('nav.orders')}</h1>
      </header>

      {waiting.length > 0 ? (
        <Section title={i18n.t('menu.tile.approve') as string}>
          <List>
            {waiting.map((row) => (
              <Row
                key={row.id}
                data-testid="orders-pending"
                title={row.storeName?.trim() || row.storeId.slice(0, 8)}
                detail={i18n.t('approval.itemsCount', { n: row.itemCount })}
                onPress={() => onOpen('approve')}
              />
            ))}
          </List>
        </Section>
      ) : null}

      {batches.length > 0 ? (
        <Section title={i18n.t('orders.today') as string}>
          <List>
            {batches.map((b) => (
              <Row
                key={b.id}
                data-testid="orders-batch"
                title={i18n.t('order.batches.batchLabel', { n: b.batchNumber })}
                detail={i18n.t('approval.itemsCount', { n: b.itemCount })}
                value={
                  <StatusChip tone={TONE[b.status] ?? 'neutral'}>
                    {i18n.t(`order.status.${b.status}` as Parameters<typeof i18n.t>[0], {
                      reason: '',
                    })}
                  </StatusChip>
                }
                onPress={() => onOpen('order')}
              />
            ))}
          </List>
        </Section>
      ) : null}

      {waiting.length === 0 && batches.length === 0 ? (
        <EmptyState
          title={i18n.t('orders.none') as string}
          hint={storeId ? undefined : (i18n.t('storeSwitcher.pickPrompt.body') as string)}
          action={null}
        />
      ) : null}
    </div>
  );
}
