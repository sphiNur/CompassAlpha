import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  ListRow,
  SectionLabel,
  rowGroupClass,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import { RoleCreateSheet } from './RoleCreateSheet';
import { RolePermissionsSheet } from './RolePermissionsSheet';

/**
 * Roles & Permissions screen — replaces the old read-only RolesList.
 *
 * Shows every role in the org with its rank + permission count, ordered
 * highest rank first (super_admin → admin → manager → ...). Each row
 * carries a small "Cannot grant" badge when the role's rank is ≥ the
 * viewer's own max rank — the user explicitly asked: "能接触权限管理
 * 的人不能分配跟自己同级或比自己高权限给别人". The rank shown here is
 * the same rank the server uses to gate `admin.grantRole`.
 *
 * Tap a role row → drill-down sheet listing the explicit permission
 * keys it grants. This is the closest thing to a permission matrix
 * we ship today; a full editable matrix belongs in round 4 (custom
 * roles).
 */
export function PermissionsSection() {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const session = useAuthStore((s) => s.session);
  const myMaxRank = session?.myMaxRank ?? 0;
  const rolesQuery = trpc.admin.roleList.useQuery();
  const [drilldownSlug, setDrilldownSlug] = useState<string | null>(null);
  // Custom-role create-mode flag (added 2026-05-05). When true the
  // sheet opens with empty fields and a "Create" footer instead of
  // the existing role's data. Only org admins reach this screen
  // (AdminPage hides it from everyone else), so the "New role" button
  // and the edit footer need no check of their own (review ADM1-27).
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title={i18n.t('people.permsHowTitle')}>
        {i18n.t('people.permsHowBody', { rank: myMaxRank })}
      </Banner>
      <div className="mt-3 flex items-center justify-between">
        <SectionLabel padded={false}>{i18n.t('people.rolesHeading')}</SectionLabel>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          + {i18n.t('people.newRoleButton')}
        </Button>
      </div>
      <div className="mt-2">
        <DataState
          query={rolesQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <EmptyState
              title={i18n.t('people.rolesEmptyTitle')}
              description={i18n.t('people.rolesEmptyBody')}
            />
          }
        >
          {(rows) => (
            <ul className={rowGroupClass} role="list">
              {rows.map((r) => {
                const grantable = r.rank < myMaxRank;
                const subtitleParts: string[] = [
                  i18n.t('people.rankLine', { rank: r.rank }),
                  i18n.t('people.permissionCount', { n: r.permissionCount }),
                ];
                const description = roleText.description(r);
                if (description) subtitleParts.push(description);
                const subtitle = subtitleParts.join(' · ');
                return (
                  <li key={r.id}>
                    <ListRow
                      label={
                        // Review WALK-04 (2026-11-09): the badges follow the
                        // name and wrap under it. Beside it they left the
                        // name 85px at 320px in Russian ("Суперадмин" cut).
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {roleText.name(r)}
                          {r.isBuiltIn ? (
                            <Badge tone="muted">{i18n.t('admin.label.builtIn')}</Badge>
                          ) : null}
                          {/* UIUX-B1: 'grantable' is the common case → silent;
                              only the blocking state earns a badge. */}
                          {grantable ? null : (
                            <Badge tone="warn">{i18n.t('people.rankOutranksYou')}</Badge>
                          )}
                        </span>
                      }
                      hint={subtitle}
                      onClick={() => setDrilldownSlug(r.slug)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      </div>

      <RolePermissionsSheet
        open={!!drilldownSlug}
        roleSlug={drilldownSlug}
        onClose={() => setDrilldownSlug(null)}
        myMaxRank={myMaxRank}
      />
      <RoleCreateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        myMaxRank={myMaxRank}
      />
    </div>
  );
}
