import { Button, Hero, List, Row } from '@compass/ui/kit';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import type { Tab } from '../stores/navStore';
import {
  useActiveRun,
  useCloseDue,
  useLinesToReceive,
  useOrdersToBuy,
  usePendingApprovals,
} from '../hooks/useWaitingCounts';

export interface TodayPageProps {
  onOpen: (tab: Tab) => void;
  onOpenSettings: () => void;
}

/**
 * What is waiting for this person, and nothing else. Each thing carries
 * its own button, so nobody has to know which section of the app a job
 * lives in. A thing with nothing waiting is not listed: an "Approve"
 * button over an empty queue is a button that does nothing.
 */
export function TodayPage({ onOpen, onOpenSettings }: TodayPageProps) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const toApprove = usePendingApprovals(can('order.approve'));
  const toBuy = useOrdersToBuy(can('run.purchase'));
  const activeRun = useActiveRun(can('run.purchase'));
  const toReceive = useLinesToReceive(can('delivery.confirm'));
  const closeDue = useCloseDue(can('settlement.record') && !!session?.member.dailyClose);

  const waiting = [
    toApprove > 0
      ? {
          key: 'approve',
          tab: 'approve' as Tab,
          title: i18n.t('menu.tile.approve'),
          detail: i18n.t('today.ordersCount', { n: toApprove }),
          action: i18n.t('nav.approve'),
        }
      : null,
    toReceive > 0
      ? {
          key: 'receive',
          tab: 'confirm' as Tab,
          title: i18n.t('today.delivery'),
          detail: i18n.t('run.label.itemsCount', { n: toReceive }),
          action: i18n.t('nav.confirm'),
        }
      : null,
    activeRun
      ? {
          key: 'run',
          tab: 'run' as Tab,
          title: i18n.t('today.runInProgress'),
          detail: activeRun.runDate,
          action: i18n.t('today.continue'),
        }
      : toBuy > 0
        ? {
            key: 'buy',
            tab: 'run' as Tab,
            title: i18n.t('menu.tile.buy'),
            detail: i18n.t('today.ordersCount', { n: toBuy }),
            action: i18n.t('nav.run'),
          }
        : null,
    closeDue === 1
      ? {
          key: 'close',
          tab: 'settlement' as Tab,
          title: i18n.t('menu.tile.close'),
          detail: undefined,
          action: i18n.t('nav.settlement'),
        }
      : null,
  ].filter((thing): thing is NonNullable<typeof thing> => thing !== null);

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      <header>
        <h1 className="text-h1 text-ink">{i18n.t('nav.today')}</h1>
        <p className="text-small text-secondary">{session?.member.orgName}</p>
      </header>

      <Hero
        data-testid="today-hero"
        label={i18n.t('today.waiting') as string}
        figure={String(waiting.length)}
        note={waiting.length === 0 ? i18n.t('today.nothing') : undefined}
      />

      {waiting.length > 0 ? (
        <List>
          {waiting.map((thing) => (
            <Row
              key={thing.key}
              data-testid={`tile-${thing.key}`}
              title={thing.title}
              detail={thing.detail}
              onPress={() => onOpen(thing.tab)}
              trailing={
                <Button
                  variant="primary"
                  inline
                  data-testid={`do-${thing.key}`}
                  onClick={() => onOpen(thing.tab)}
                >
                  {thing.action}
                </Button>
              }
            />
          ))}
        </List>
      ) : null}

      <List>
        <Row
          data-testid="menu-settings"
          title={i18n.t('menu.settings')}
          detail={i18n.t('menu.settingsHint')}
          onPress={onOpenSettings}
        />
      </List>
    </div>
  );
}
