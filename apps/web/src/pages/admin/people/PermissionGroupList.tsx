import type { ReactNode } from 'react';
import { SectionLabel, rowGroupClass } from '@compass/ui';
import { useRoleLabels } from '../../../hooks/useI18n';

/**
 * Permissions under their group's name (groupPermissions), each group one
 * card of rows divided by hairlines (UI-6, UI-13). Review ADM1-13 /
 * ADM1-23 (2026-11-12): the role sheets (create, edit, read) and the
 * member's override sheet each drew this list themselves, as grey pills
 * or a grey card per permission. Not "PermissionGroups": that name
 * differs from permissionGroups.ts only in case, and an import of
 * '../permissionGroups' could find either.
 */
export function PermissionGroupList<P extends { key: string }>({
  groups,
  renderRow,
}: {
  groups: ReadonlyArray<readonly [segment: string, perms: readonly P[]]>;
  renderRow: (perm: P) => ReactNode;
}) {
  const roleText = useRoleLabels();
  return (
    <div className="flex flex-col gap-3">
      {groups.map(([segment, perms]) => (
        <section key={segment}>
          <SectionLabel as="h3" padded={false} className="mb-1">
            {roleText.permissionGroup(segment)}
          </SectionLabel>
          <ul className={rowGroupClass} role="list">
            {perms.map((p) => (
              <li key={p.key} className="px-4 py-2">
                {renderRow(p)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
