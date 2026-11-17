/**
 * The More page (owner 2026-11-17: "put Admin in More, or make them one
 * page"). At the top, the tabs the bar has no room for and, in a browser,
 * Settings; below them Admin, for those who may open it. Inside an Admin
 * section the rows step aside, so the section has the screen.
 */
import { Suspense } from 'react';
import { IconSettings, LoadingState, rowGroupClass } from '@compass/ui';
import { resilientLazy } from '../../components/resilientLazy';
import { useI18n } from '../../hooks/useI18n';
import { useNavStore } from '../../stores/navStore';
import { importAdminPage } from '../pageChunks';
import { useNavBadges } from './BottomNav';
import { useMoreNav } from './moreNav';
import type { TabDef } from './tabs';

const AdminPage = resilientLazy(importAdminPage);

export function MorePage() {
  const i18n = useI18n();
  const { tabs, admin, onSelect, onOpenSettings } = useMoreNav();
  const atAdminHome = useNavStore((s) => s.adminSection === 'home');
  const badges = useNavBadges(tabs);
  const showRows = atAdminHome && (tabs.length > 0 || !!onOpenSettings);
  return (
    <>
      {showRows ? (
        <div className="px-4 pt-3">
          <ul className={rowGroupClass} data-testid="more-nav-list">
            {tabs.map((t) => (
              <li key={t.key}>
                <MoreRow
                  tab={t}
                  badge={badges[t.key]}
                  label={i18n.t(t.labelKey)}
                  onClick={() => onSelect(t.key)}
                />
              </li>
            ))}
            {onOpenSettings ? (
              <li>
                <button
                  type="button"
                  data-testid="open-settings"
                  aria-haspopup="dialog"
                  onClick={onOpenSettings}
                  className="press flex min-h-12 w-full items-center gap-3 px-4 text-left text-old-h3 text-[var(--c-fg)]"
                >
                  <IconSettings size={22} />
                  <span className="min-w-0 flex-1 truncate">{i18n.t('settings.title')}</span>
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {admin ? (
        <Suspense fallback={<LoadingState />}>
          <AdminPage />
        </Suspense>
      ) : null}
    </>
  );
}

function MoreRow({
  tab,
  badge,
  label,
  onClick,
}: {
  tab: TabDef;
  badge: number | 'dot' | undefined;
  label: string;
  onClick: () => void;
}) {
  const i18n = useI18n();
  const Icon = tab.Icon;
  const named =
    badge === undefined
      ? undefined
      : badge === 'dot'
        ? i18n.t('nav.badge.due', { label })
        : i18n.t('nav.badge.count', { label, n: badge });
  return (
    <button
      type="button"
      data-testid={`nav-${tab.key}`}
      aria-label={named}
      onClick={onClick}
      className="press flex min-h-12 w-full items-center gap-3 px-4 text-left text-old-h3 text-[var(--c-fg)]"
    >
      <Icon size={22} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined ? (
        <span
          aria-hidden
          data-testid={`nav-badge-${tab.key}`}
          className={
            badge === 'dot'
              ? 'h-2.5 w-2.5 rounded-full bg-[var(--c-danger)]'
              : 'min-w-[20px] rounded-full bg-[var(--c-danger)] px-1.5 text-center text-old-label font-semibold leading-5 text-[var(--c-danger-fg)] tabular-nums'
          }
        >
          {badge === 'dot' ? null : badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}
