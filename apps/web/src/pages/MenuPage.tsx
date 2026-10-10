import { List, Page, Row, Tile, TileGrid } from '@compass/ui/kit';
import { useOrdersToBuy, usePendingApprovals } from '../hooks/useWaitingCounts';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import type { Tab } from '../stores/navStore';

export interface MenuPageProps {
  onOpen: (tab: Tab) => void;
  onOpenSettings: () => void;
}

/**
 * Everything that is not part of someone's daily round: records, the
 * administration screens, and their own settings. The navigation holds
 * the tasks; this holds the rest, so neither has to be searched.
 */
export function MenuPage({ onOpen, onOpenSettings }: MenuPageProps) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const toApprove = usePendingApprovals(can('order.approve'));
  const toBuy = useOrdersToBuy(can('run.purchase'));

  return (
    <Page>
      <header>
        <h1 className="text-h1 text-ink">{session?.member.orgName}</h1>
        <p className="text-body text-secondary">{session?.user.displayName}</p>
      </header>

      {/* What is waiting, for the work this person does. */}
      {can('order.approve') || can('run.purchase') ? (
        <TileGrid>
          {can('order.approve') ? (
            <Tile
              data-testid="tile-approve"
              tone="orange"
              label={i18n.t('menu.tile.approve')}
              count={toApprove}
              onPress={() => onOpen('approve')}
            />
          ) : null}
          {can('run.purchase') ? (
            <Tile
              data-testid="tile-buy"
              tone="blue"
              label={i18n.t('menu.tile.buy')}
              count={toBuy}
              onPress={() => onOpen('run')}
            />
          ) : null}
        </TileGrid>
      ) : null}

      <List>
        {can('prices.view') ? (
          <Row
            data-testid="menu-history"
            title={i18n.t('menu.history')}
            detail={i18n.t('menu.historyHint')}
            onPress={() => onOpen('history')}
          />
        ) : null}
        {can('users.manage') ? (
          <Row
            data-testid="menu-admin"
            title={i18n.t('menu.admin')}
            detail={i18n.t('menu.adminHint')}
            onPress={() => onOpen('admin')}
          />
        ) : null}
        <Row
          data-testid="menu-settings"
          title={i18n.t('menu.settings')}
          detail={i18n.t('menu.settingsHint')}
          onPress={onOpenSettings}
        />
      </List>
    </Page>
  );
}
