import { lazy, Suspense } from 'react';
import { Button, EmptyState, List, Row, Section } from '@compass/ui/kit';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import { useActiveRun, useOrdersToBuy } from '../hooks/useWaitingCounts';
import type { Tab } from '../stores/navStore';

const HistoryPage = lazy(() =>
  import('../pages/HistoryPage').then((m) => ({ default: m.HistoryPage })),
);

/**
 * Buying, now and before: the trip that is under way or ready to start,
 * and under it what earlier trips bought and cost.
 */
export function PurchasingPage({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const buyer = can('run.purchase');
  const activeRun = useActiveRun(buyer);
  const toBuy = useOrdersToBuy(buyer);

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      <header>
        <h1 className="text-h1 text-ink">{i18n.t('nav.purchasing')}</h1>
      </header>

      {buyer ? (
        activeRun ? (
          <List>
            <Row
              data-testid="purchasing-current"
              title={i18n.t('today.runInProgress')}
              detail={activeRun.runDate}
              trailing={
                <Button
                  variant="primary"
                  inline
                  data-testid="open-run"
                  onClick={() => onOpen('run')}
                >
                  {i18n.t('today.continue')}
                </Button>
              }
            />
          </List>
        ) : toBuy > 0 ? (
          <List>
            <Row
              data-testid="purchasing-current"
              title={i18n.t('menu.tile.buy')}
              detail={i18n.t('today.ordersCount', { n: toBuy })}
              trailing={
                <Button
                  variant="primary"
                  inline
                  data-testid="open-run"
                  onClick={() => onOpen('run')}
                >
                  {i18n.t('nav.run')}
                </Button>
              }
            />
          </List>
        ) : (
          <EmptyState title={i18n.t('purchasing.none') as string} action={null} />
        )
      ) : null}

      {can('prices.view') ? (
        <Section title={i18n.t('purchasing.past') as string}>
          <Suspense
            fallback={<p className="text-small text-secondary">{i18n.t('common.loading')}</p>}
          >
            <HistoryPage />
          </Suspense>
        </Section>
      ) : null}
    </div>
  );
}
