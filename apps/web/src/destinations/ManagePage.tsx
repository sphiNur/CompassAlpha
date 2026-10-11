import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useNavStore } from '../stores/navStore';
import { useI18n } from '../hooks/useI18n';
import type { Tab } from '../stores/navStore';
import type { CatalogSub, OperationsSub } from '../pages/admin/shared';
import {
  BuildingIcon,
  ChevronIcon,
  CloseDayIcon,
  DishIcon,
  EyeIcon,
  OrdersIcon,
  PersonIcon,
  PulseIcon,
  ReceiptIcon,
  ReceiveIcon,
  ShieldIcon,
  StallIcon,
  StoreIcon,
  TagIcon,
  TrendIcon,
  WalletIcon,
} from './icons';

const AdminPage = lazy(() => import('../pages/AdminPage').then((m) => ({ default: m.AdminPage })));

interface Entry {
  key: string;
  icon: ReactNode;
  title: string;
  hint?: string;
  open: () => void;
}

/**
 * What is set up rather than done every day, laid out after the Wise
 * app's account screen: short groups of rows, each with a disc, a name
 * and a line saying what is behind it.
 *
 * Every row goes straight to the thing. The three pages that only led
 * on to other pages (the admin home, the catalogue home, the reports
 * home) are not on the way any more; what they listed is listed here.
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
  const admin = can('users.manage');

  const section = useNavStore((s) => s.adminSection);
  const setSection = useNavStore((s) => s.setAdminSection);
  const setCatalogSub = useNavStore((s) => s.setCatalogSub);
  const setOpsSub = useNavStore((s) => s.setOpsSub);

  // Inside one of them: that screen has the page, with its own way back.
  if (admin && section !== 'home') {
    return (
      <Suspense
        fallback={
          <p className="px-page py-xl text-body text-secondary">{i18n.t('common.loading')}</p>
        }
      >
        <AdminPage />
      </Suspense>
    );
  }

  const catalogue = (sub: CatalogSub) => () => {
    setCatalogSub(sub);
    setSection('catalog');
  };
  const report = (sub: OperationsSub) => () => {
    setOpsSub(sub);
    setSection('operations');
  };

  const groups: Array<{ key: string; title?: string; entries: Entry[] }> = [];
  if (closes) {
    groups.push({
      key: 'daily',
      entries: [
        {
          key: 'close',
          icon: <CloseDayIcon />,
          title: i18n.t('settlement.title') as string,
          open: () => onOpen('settlement'),
        },
      ],
    });
  }
  if (admin) {
    groups.push({
      key: 'catalog',
      title: i18n.t('admin.section.catalog') as string,
      entries: [
        {
          key: 'skus',
          icon: <ReceiveIcon />,
          title: i18n.t('admin.subsection.skus') as string,
          hint: i18n.t('admin.subsection.skusHint') as string,
          open: catalogue('skus'),
        },
        {
          key: 'categories',
          icon: <TagIcon />,
          title: i18n.t('admin.subsection.categories') as string,
          hint: i18n.t('admin.subsection.categoriesHint') as string,
          open: catalogue('categories'),
        },
        {
          key: 'suppliers',
          icon: <StallIcon />,
          title: i18n.t('admin.subsection.suppliers') as string,
          hint: i18n.t('admin.subsection.suppliersHint') as string,
          open: catalogue('suppliers'),
        },
        {
          key: 'dishes',
          icon: <DishIcon />,
          title: i18n.t('admin.subsection.dishes') as string,
          hint: i18n.t('admin.subsection.dishesHint') as string,
          open: catalogue('dishes'),
        },
        {
          key: 'expenseTemplates',
          icon: <ReceiptIcon />,
          title: i18n.t('admin.subsection.expenseTemplates') as string,
          hint: i18n.t('admin.subsection.expenseTemplatesHint') as string,
          open: catalogue('expenseTemplates'),
        },
      ],
    });
    groups.push({
      key: 'people',
      title: i18n.t('manage.people') as string,
      entries: [
        {
          key: 'stores',
          icon: <StoreIcon />,
          title: i18n.t('admin.section.stores') as string,
          hint: i18n.t('admin.section.storesHint') as string,
          open: () => setSection('stores'),
        },
        {
          key: 'permissions',
          icon: <ShieldIcon />,
          title: i18n.t('admin.section.permissions') as string,
          hint: i18n.t('admin.section.permissionsHint') as string,
          open: () => setSection('permissions'),
        },
        {
          key: 'organization',
          icon: <BuildingIcon />,
          title: i18n.t('admin.section.organization') as string,
          hint: i18n.t('admin.section.organizationHint') as string,
          open: () => setSection('organization'),
        },
      ],
    });
    groups.push({
      key: 'reports',
      title: i18n.t('admin.section.operations') as string,
      entries: [
        {
          key: 'finance',
          icon: <WalletIcon />,
          title: i18n.t('admin.subsection.finance') as string,
          hint: i18n.t('admin.subsection.financeHint') as string,
          open: report('finance'),
        },
        {
          key: 'priceReport',
          icon: <TrendIcon />,
          title: i18n.t('admin.subsection.priceReport') as string,
          hint: i18n.t('admin.subsection.priceReportHint') as string,
          open: report('priceReport'),
        },
        {
          key: 'activity',
          icon: <PulseIcon />,
          title: i18n.t('admin.subsection.activity') as string,
          hint: i18n.t('admin.subsection.activityHint') as string,
          open: report('activity'),
        },
        {
          key: 'history',
          icon: <OrdersIcon />,
          title: i18n.t('admin.subsection.history') as string,
          hint: i18n.t('admin.subsection.historyHint') as string,
          open: report('history'),
        },
        {
          key: 'adminAudit',
          icon: <EyeIcon />,
          title: i18n.t('admin.subsection.audit') as string,
          hint: i18n.t('admin.subsection.auditHint') as string,
          open: report('adminAudit'),
        },
      ],
    });
  }
  groups.push({
    key: 'me',
    entries: [
      {
        key: 'settings',
        icon: <PersonIcon />,
        title: i18n.t('menu.settings') as string,
        hint: i18n.t('menu.settingsHint') as string,
        open: onOpenSettings,
      },
    ],
  });

  return (
    <div className="flex flex-col gap-xl px-page pb-xl pt-sm">
      <h1 className="text-h1 text-ink">{i18n.t('nav.manage')}</h1>
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-sm">
          {group.title ? <h2 className="text-body text-secondary">{group.title}</h2> : null}
          {group.entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              data-testid={`manage-${entry.key}`}
              onClick={entry.open}
              className="flex min-h-row items-center gap-lg py-sm text-start outline-none active:opacity-60"
            >
              <span
                aria-hidden
                className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-ink"
              >
                {entry.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-label text-ink">{entry.title}</span>
                {entry.hint ? (
                  <span className="block text-small text-secondary">{entry.hint}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-forest">
                <ChevronIcon />
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
