import { lazy, Suspense } from 'react';
import { List, Row } from '@compass/ui/kit';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../hooks/useI18n';
import type { Tab } from '../stores/navStore';

const AdminPage = lazy(() => import('../pages/AdminPage').then((m) => ({ default: m.AdminPage })));

/**
 * What is set up rather than done every day: the catalogue, stores and
 * people, reports, and for an organisation that uses it, the daily close.
 */
export function ManagePage({
  onOpen,
  onOpenSettings,
}: {
  onOpen: (tab: Tab) => void;
  onOpenSettings: () => void;
}) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  const closes = can('settlement.record') && !!session?.member.dailyClose;

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      <header>
        <h1 className="text-h1 text-ink">{i18n.t('nav.manage')}</h1>
      </header>
      <List>
        {closes ? (
          <Row
            data-testid="manage-close"
            title={i18n.t('settlement.title')}
            onPress={() => onOpen('settlement')}
          />
        ) : null}
        <Row
          data-testid="manage-settings"
          title={i18n.t('menu.settings')}
          detail={i18n.t('menu.settingsHint')}
          onPress={onOpenSettings}
        />
      </List>
      {can('users.manage') ? (
        <Suspense
          fallback={<p className="text-small text-secondary">{i18n.t('common.loading')}</p>}
        >
          <AdminPage />
        </Suspense>
      ) : null}
    </div>
  );
}
