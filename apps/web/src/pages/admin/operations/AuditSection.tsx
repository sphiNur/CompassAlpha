/**
 * Admin → Operations → Audit log. Review ADM2-10 (2026-11-11): one file
 * per Operations section.
 */
import { useMemo, useState } from 'react';
import { Badge, Chip, ChipBar, DataState, EmptyState, rowGroupClass } from '@compass/ui';
import { PAGE_SIZE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useAdminStoreIds } from '../../../hooks/useAdminAuthority';
import {
  useDateFormat,
  useI18n,
  useProductName,
  useRoleLabels,
  useUnitLabel,
} from '../../../hooks/useI18n';
import { auditCategory, describeAuditRow, type AuditCategory } from './auditSentence';
import { auditChangeLines, type ChangeFormat } from './auditChangeLines';

/**
 * Admin audit log (added 2026-05-05).
 *
 * Renders rows from `domain.policy_decisions`, which gets a row for every
 * `auditAdmin()` call (apps/api/src/services/adminAudit.ts).
 *
 * Display goal: a busy chain owner should be able to skim "what
 * happened in the last hour" and answer:
 *   - Who changed this SKU?
 *   - Who promoted Ali to manager?
 *   - When did Aziz get the `order.approve` override?
 *
 * auditSentence.ts words each action and sorts it into a filter; an action
 * it does not know gets a generic line under "Other". Review ADM2-40
 * (2026-11-12): the list of actions kept here named six objects and missed
 * the rest (members, invites, purges, imports…); the auditAdmin calls are
 * the list.
 */
export function AdminAuditSection() {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const productName = useProductName();
  const roleLabels = useRoleLabels();
  const unitLabel = useUnitLabel();
  // ADM2-06: how the before / after values of an edit read.
  const changeFormat: ChangeFormat = {
    empty: '—',
    localName: (names) => productName({ names }),
    unit: unitLabel.uncounted,
    paymentMethod: (method) =>
      method === 'transfer'
        ? i18n.t('run.history.payment.transfer')
        : i18n.t('run.history.payment.cash'),
    active: (on) => (on ? i18n.t('admin.label.active') : i18n.t('stores.paused')),
  };
  // B2 (2026-05-06): per-store filter. The pill row at the top lets an
  // admin scope the log to one store; rows pre-2026-05-06 (NULL scope)
  // disappear under the filter, which is correct — they predate the
  // column.
  const session = useAuthStore((s) => s.session);
  const sessionStores = useMemo(() => session?.stores ?? [], [session?.stores]);
  // ADM-16: the server only returns rows for stores the actor administers,
  // so a store they merely work in was a filter that always came up empty.
  const adminStoreIds = useAdminStoreIds();
  const filterStores = sessionStores.filter((st) => adminStoreIds.has(st.id));
  // M1.9 (2026-05-07): the raw `JSON.stringify(r.inputs)` payload
  // preview looks like a debugger artifact to a non-technical chain
  // owner. Hide for everyone-but-super-admin so the verb+actor+time
  // line stays clean. Forensics still available via the DB row for
  // anyone with shell access.
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  // 2026-10-21 FE-08: client-side category filter over the loaded page.
  const [categoryFilter, setCategoryFilter] = useState<AuditCategory | 'all'>('all');
  const auditQuery = trpc.admin.adminAuditList.useQuery({
    limit: PAGE_SIZE.list,
    ...(storeFilter ? { storeId: storeFilter } : {}),
  });
  const storeNameById = useMemo(
    () => new Map(sessionStores.map((s) => [s.id, s.name])),
    [sessionStores],
  );
  // ADM2-34: "All", "Members" and "Other" are the filter's own words; the
  // rest name the admin sections the actions belong to.
  const categoryLabel: Record<AuditCategory | 'all', string> = {
    all: i18n.t('ops.audit.filter.all'),
    people: i18n.t('ops.audit.filter.people'),
    roles: i18n.t('admin.section.permissions'),
    stores: i18n.t('admin.section.stores'),
    catalog: i18n.t('admin.section.catalog'),
    other: i18n.t('ops.audit.filter.other'),
  };
  // Catalog rows get a per-kind badge (SKUs / Suppliers …) instead of
  // the generic "Catalog"; one without a kind (an import) keeps it.
  const kindLabel: Record<string, string> = {
    sku: i18n.t('admin.subsection.skus'),
    category: i18n.t('admin.subsection.categories'),
    supplier: i18n.t('admin.subsection.suppliers'),
    expenseTemplate: i18n.t('admin.subsection.expenseTemplates'),
    dish: i18n.t('admin.subsection.dishes'),
  };
  return (
    <div className="px-4 py-3">
      {/* Filter chip row — only renders when there's something to
          filter. Single-store users see one chip + "all". */}
      {filterStores.length > 0 ? (
        <ChipBar
          variant="radio"
          ariaLabel={i18n.t('ops.audit.allScopes')}
          className="-mx-4 -my-1.5 mb-1.5 px-4 py-1.5"
        >
          <Chip selected={storeFilter === null} onClick={() => setStoreFilter(null)}>
            {i18n.t('ops.audit.allScopes')}
          </Chip>
          {filterStores.map((st) => (
            <Chip
              key={st.id}
              selected={storeFilter === st.id}
              onClick={() => setStoreFilter(st.id)}
            >
              {st.name}
            </Chip>
          ))}
        </ChipBar>
      ) : null}
      {/* Six options: a scrolling ChipBar, not Segmented (2-4 max). */}
      <ChipBar
        variant="radio"
        ariaLabel={i18n.t('ops.audit.filterLabel')}
        // V4: -my-1.5 py-1.5 rather than py-0: same layout, room for hit-44.
        className="-mx-4 -my-1.5 mb-1.5 px-4 py-1.5"
      >
        {(['all', 'people', 'roles', 'stores', 'catalog', 'other'] as const).map((value) => (
          <Chip
            key={value}
            selected={categoryFilter === value}
            onClick={() => setCategoryFilter(value)}
          >
            {categoryLabel[value]}
          </Chip>
        ))}
      </ChipBar>
      <DataState
        query={auditQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={
              storeFilter
                ? i18n.t('ops.audit.emptyStoreTitle', {
                    store: storeNameById.get(storeFilter) ?? '—',
                  })
                : i18n.t('ops.audit.emptyTitle')
            }
            description={
              storeFilter ? i18n.t('ops.audit.emptyStoreBody') : i18n.t('ops.audit.emptyBody')
            }
          />
        }
      >
        {(allRows) => {
          const rows =
            categoryFilter === 'all'
              ? allRows
              : allRows.filter((r) => auditCategory(r.action) === categoryFilter);
          if (rows.length === 0) {
            return <EmptyState title={i18n.t('ops.audit.emptyFilterTitle')} />;
          }
          return (
            <ul className={rowGroupClass} role="list">
              {rows.map((r) => {
                // 2026-10-21 FE-08: one readable sentence per row ("A
                // granted Manager to B") from server-resolved names,
                // instead of raw verb/object words and id prefixes.
                const s = describeAuditRow(r, {
                  unknown: i18n.t('ops.audit.unknown'),
                  system: i18n.t('ops.activity.system'),
                  roleName: (role) => roleLabels.name(role),
                  permission: (key) => roleLabels.permission(key, null),
                  localName: (names) => productName({ names }),
                  day: (d) => dateFmt.calendarDay(d),
                });
                const changes = auditChangeLines(r.inputs, changeFormat);
                const badge =
                  s.category === 'catalog'
                    ? (kindLabel[s.object] ?? categoryLabel.catalog)
                    : categoryLabel[s.category];
                // Store chip: the resolved name, else the session's store
                // list (B2 / M3.17), else "unknown store" (review ADM2-42:
                // it was the id's first characters).
                const storeChip = r.scopeStoreId
                  ? (storeNameById.get(r.scopeStoreId) ??
                    r.labels.storeName ??
                    i18n.t('common.unknownStore'))
                  : null;
                // 2026-07-30: `undefined` meant "browser locale".
                const when = dateFmt.dateTime(r.occurredAt);
                return (
                  <li key={r.id} className="min-w-0">
                    <div className="flex items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <Badge tone={s.tone}>{badge}</Badge>
                          {storeChip ? <Badge tone="muted">{storeChip}</Badge> : null}
                        </div>
                        <div className="mt-1 text-old-body text-[var(--c-fg)]">
                          {i18n.t(s.key, s.params)}
                        </div>
                        {changes.length > 0 ? (
                          <ul className="mt-1 flex flex-col gap-0.5 text-old-label text-[var(--c-fg-muted)]">
                            {changes.map((c, i) => (
                              <li key={`${c.field}-${i}`} className="break-words">
                                {i18n.t('ops.audit.change', {
                                  field: i18n.t(c.field),
                                  before: c.before,
                                  after: c.after,
                                })}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <div className="mt-1 text-old-label text-[var(--c-fg-muted)]">
                          {r.actor?.tgUsername ? `@${r.actor.tgUsername} · ` : ''}
                          {when}
                        </div>
                        {/* Lightweight payload preview — JSON.stringify
                            fits one line for most actions; long inputs
                            are truncated since the full row is in the DB
                            for forensics. M1.9: super_admin only — looks
                            like a debugger artifact to non-tech users. */}
                        {isSuperAdmin ? (
                          <details className="mt-2">
                            <summary className="hit-44 cursor-pointer text-old-label font-medium text-[var(--c-fg-muted)]">
                              {i18n.t('ops.audit.inputs')} · {r.action}
                              {r.resourceId ? ` · ${r.resourceId.slice(0, 8)}…` : ''}
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2 py-1 font-mono text-old-label text-[var(--c-fg-muted)]">
                              {JSON.stringify(r.inputs, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </DataState>
    </div>
  );
}
