import { List, Page, Row } from '@compass/ui/kit';
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
  const go = (
    <span aria-hidden className="text-body text-secondary">
      ›
    </span>
  );

  return (
    <Page>
      <header>
        <h1 className="text-h1 text-ink">{session?.member.orgName}</h1>
        <p className="text-body text-secondary">{session?.user.displayName}</p>
      </header>

      <List>
        {can('prices.view') ? (
          <Row
            data-testid="menu-history"
            title={i18n.t('menu.history')}
            detail={i18n.t('menu.historyHint')}
            value={go}
            onPress={() => onOpen('history')}
          />
        ) : null}
        {can('users.manage') ? (
          <Row
            data-testid="menu-admin"
            title={i18n.t('menu.admin')}
            detail={i18n.t('menu.adminHint')}
            value={go}
            onPress={() => onOpen('admin')}
          />
        ) : null}
        <Row
          data-testid="menu-settings"
          title={i18n.t('menu.settings')}
          detail={i18n.t('menu.settingsHint')}
          value={go}
          onPress={onOpenSettings}
        />
      </List>
    </Page>
  );
}
