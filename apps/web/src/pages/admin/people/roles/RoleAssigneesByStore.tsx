import { useMemo } from 'react';
import { Avatar, Badge, SectionLabel } from '@compass/ui';
import { useI18n } from '../../../../hooks/useI18n';

/**
 * RoleAssigneesByStore (B1, 2026-05-06).
 *
 * Buckets role bindings into "Org-level" (scope=global) plus one
 * section per store. Each row shows the assignee's display name +
 * @username; tapping doesn't navigate (this view is for "who is
 * where", not for editing — that's on the member card).
 */
export function RoleAssigneesByStore({
  assignees,
}: {
  assignees: Array<{
    bindingId: string;
    memberId: string;
    displayName: string;
    avatarUrl: string | null;
    tgUsername: string | null;
    scopeType: 'global' | 'store';
    scopeId: string | null;
    storeName: string | null;
    /** ADM1-20: suspended holders are listed too, marked. */
    status?: string;
  }>;
}) {
  const i18n = useI18n();
  const grouped = useMemo(() => {
    // 'org-level' bucket plus per-store buckets keyed by storeId.
    type Bucket = { label: string; members: typeof assignees };
    const buckets = new Map<string, Bucket>();
    const orgLevelKey = '__org__';
    for (const a of assignees) {
      let key: string;
      let label: string;
      if (a.scopeType === 'global' || !a.scopeId) {
        key = orgLevelKey;
        label = i18n.t('people.orgLevelLabel');
      } else {
        key = a.scopeId;
        label = a.storeName ?? i18n.t('people.storeGone');
      }
      const cur = buckets.get(key) ?? { label, members: [] };
      cur.members.push(a);
      buckets.set(key, cur);
    }
    // Sort: org-level first, then alphabetical store name.
    const out = [...buckets.entries()];
    out.sort(([ka, va], [kb, vb]) => {
      if (ka === orgLevelKey) return -1;
      if (kb === orgLevelKey) return 1;
      return va.label.localeCompare(vb.label, i18n.locale);
    });
    return out;
  }, [assignees, i18n]);

  return (
    <div className="mt-2 border-t border-[var(--c-divider)] pt-3">
      <SectionLabel padded={false}>
        {i18n.t('people.assigneesHeading', { n: assignees.length })}
      </SectionLabel>
      <div className="mt-1 flex flex-col gap-3">
        {grouped.map(([key, bucket]) => (
          <section key={key}>
            <h4 className="mb-1 text-old-label font-semibold text-[var(--c-fg-muted)]">
              {bucket.label} ({bucket.members.length})
            </h4>
            <ul className="flex flex-col gap-1">
              {bucket.members.map((a) => (
                <li
                  key={a.bindingId}
                  className="flex items-center gap-2 rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline px-3 py-1.5"
                >
                  <Avatar src={a.avatarUrl} name={a.displayName} size={24} />
                  <span className="text-old-body text-[var(--c-fg)]">{a.displayName}</span>
                  {a.tgUsername ? (
                    <span className="text-old-label text-[var(--c-fg-muted)]">@{a.tgUsername}</span>
                  ) : null}
                  {a.status === 'suspended' || a.status === 'invited' ? (
                    <Badge tone="warn" className="ml-auto">
                      {i18n.t(`people.memberStatus.${a.status}`)}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
