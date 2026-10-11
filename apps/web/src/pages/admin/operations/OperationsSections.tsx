/**
 * Admin → Operations sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 1, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - ActivitySection    KPI tiles + event feed (+ embedded DebugPage)
 *   - HistorySection     submission history (expandable order cards)
 *   - AdminAuditSection  admin action audit log
 *   - PriceReportSection price drift report
 *   - FinanceSection     daily / by-supplier / by-store expense views
 *   - MaintenanceSection danger zone (+ TargetedPurgeBrowser, internal)
 */
import { useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataState,
  EmptyState,
  Field,
  Input,
  Sheet,
  Spinner,
  Tile,
  useToast,
} from '@compass/ui';
import { PAGE_SIZE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';
import { DebugPage } from '../../DebugPage';

// ============ Activity ============

export function ActivitySection() {
  const dateFmt = useDateFormat();
  const i18n = useI18n();
  const overview = trpc.admin.overview.useQuery();
  const eventsQuery = trpc.admin.recentEvents.useQuery({ limit: PAGE_SIZE.feed });
  const [showDebug, setShowDebug] = useState(false);
  // M1.9 (2026-05-07): the embedded debug console (348 lines of dev
  // tooling: live/server/health log streams, ring buffers, raw JSON)
  // does not belong in the chain owner's day-1 admin view. Gate to
  // super_admin so it stays reachable for the dev account but the
  // owner doesn't accidentally collapse-expand it and leave 2s polls
  // running in the background.
  const session = useAuthStore((s) => s.session);
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;

  return (
    <div className="px-4 py-3">
      <DataState query={overview}>
        {(d) => (
          <div className="grid grid-cols-2 gap-3">
            <Tile label={i18n.t('admin.tile.members')} value={d.memberCount} />
            <Tile label={i18n.t('admin.tile.stores')} value={d.storeCount} />
            <Tile label={i18n.t('admin.tile.activeSkus')} value={d.skuCount} />
            <Tile label={i18n.t('admin.tile.totalRuns')} value={d.runCount} />
            <Tile
              label={i18n.t('admin.tile.pendingApprovals')}
              value={d.pendingApprovals}
              accent={d.pendingApprovals > 0 ? 'warn' : 'muted'}
            />
            <Tile label={i18n.t('admin.tile.ordersThisWeek')} value={d.ordersThisWeek} />
          </div>
        )}
      </DataState>

      <h2 className="mt-6 mb-2 text-old-h2 font-semibold text-[var(--c-fg)]">Recent events</h2>
      <DataState
        query={eventsQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('ops.activity.emptyTitle')}
            description={i18n.t('ops.activity.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-1.5" role="list">
            {rows.map((e) => {
              // M3.21 (2026-05-18): surface ClaimReleased.reason inline
              // so admins can spot non-routine releases (override / timeout)
              // at a glance. Override = somebody took over another
              // approver's claim; timeout = the worker swept an idle
              // claim. Both warrant a heads-up tint; manual / pagehide
              // are routine, no decoration.
              const claimReason =
                e.type === 'ClaimReleased'
                  ? (e.payload as { reason?: string } | null)?.reason
                  : undefined;
              const isIntervention = claimReason === 'override' || claimReason === 'timeout';
              const rowBg = isIntervention
                ? 'bg-[oklch(97%_0.07_75)] ring-[oklch(35%_0.16_75)]/20'
                : 'bg-[var(--c-surface)] ring-hairline';
              return (
                <li
                  key={e.id}
                  className={`flex flex-col gap-0.5 rounded-[var(--r-card)] px-3 py-2 ring-hairline ${rowBg}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="font-mono text-old-label font-semibold text-[var(--c-fg)]"
                      title={
                        claimReason === 'override'
                          ? 'Another approver took over this claim — see banner on ApprovalPage'
                          : claimReason === 'timeout'
                            ? 'Worker released this claim after the idle threshold (CLAIM_TIMEOUT_MINUTES)'
                            : undefined
                      }
                    >
                      {e.streamType}.{e.type}
                      {claimReason ? (
                        <span
                          className={
                            isIntervention
                              ? 'ml-1.5 text-old-tiny font-medium uppercase tracking-wider text-[oklch(35%_0.16_75)]'
                              : 'ml-1.5 text-old-tiny font-medium uppercase tracking-wider text-[var(--c-fg-muted)]'
                          }
                        >
                          · {claimReason}
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-old-tiny text-[var(--c-fg-muted)]">
                      seq {e.seq}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
                    <span className="truncate">
                      {e.actor?.displayName ?? 'system'}
                      {e.actor?.tgUsername ? ` · @${e.actor.tgUsername}` : ''}
                    </span>
                    <span className="font-mono text-old-tiny">
                      {/* 2026-07-30: `[]` meant "browser locale". */}
                      {dateFmt.dateTime(e.occurredAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {isSuperAdmin ? (
        <>
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="press mt-6 inline-flex items-center gap-1 text-old-label text-[var(--c-fg-muted)]"
          >
            {showDebug ? '▾' : '▸'} Debug console
          </button>
          {showDebug ? (
            <div className="-mx-4 mt-2 border-t border-[var(--c-divider)]">
              <DebugPage />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// Tile removed — imported from @compass/ui.

// ============ Submission history ============

/**
 * Relative "how long ago" label.
 *
 * 2026-07-30: took the i18n instance as a parameter rather than reading a hook,
 * so it stays a pure function (callers are inside components that already have
 * `i18n`). Previously returned hardcoded English — "just now" / "3m ago" —
 * inside an otherwise Chinese activity feed.
 */

// ============ Maintenance ============

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Surgical purge browser. Two stacked lists (Orders / Runs) for the
 * chosen date; each row has its own Delete button that opens a
 * dry-run preview sheet before committing.
 */
function TargetedPurgeBrowser() {
  const [date, setDate] = useState(todayIso());
  const [tab, setTab] = useState<'orders' | 'runs'>('orders');
  const sessionsQuery = trpc.admin.sessionList.useQuery({ date, limit: PAGE_SIZE.list });
  const runsQuery = trpc.admin.runList.useQuery({ date, limit: PAGE_SIZE.list });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();

  const [sessionTarget, setSessionTarget] = useState<{
    sessionId: string;
    label: string;
    preview?: { total: number; byTable: Record<string, number> };
  } | null>(null);
  const [runTarget, setRunTarget] = useState<{
    runId: string;
    label: string;
    preview?: { total: number; byTable: Record<string, number>; sessionIds: string[] };
  } | null>(null);

  const sessionDryRun = trpc.admin.purgeSession.useMutation({
    onSuccess: (data) => {
      setSessionTarget((prev) =>
        prev ? { ...prev, preview: { total: data.total, byTable: data.byTable } } : prev,
      );
    },
    onError: (err) => {
      errToast('common.error')(err);
      setSessionTarget(null);
    },
  });
  const sessionCommit = trpc.admin.purgeSession.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.sessionDeleted', { n: data.total }));
      setSessionTarget(null);
      void utils.admin.sessionList.invalidate();
      void utils.admin.runList.invalidate();
      void utils.invalidate(); // also bump any open OrderPage / ApprovalPage
    },
    onError: errToast('common.error'),
  });

  const runDryRun = trpc.admin.purgeRun.useMutation({
    onSuccess: (data) => {
      setRunTarget((prev) =>
        prev
          ? {
              ...prev,
              preview: {
                total: data.total,
                byTable: data.byTable,
                sessionIds: data.sessionIds,
              },
            }
          : prev,
      );
    },
    onError: (err) => {
      errToast('common.error')(err);
      setRunTarget(null);
    },
  });
  const runCommit = trpc.admin.purgeRun.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.runDeleted', { n: data.total }));
      setRunTarget(null);
      void utils.admin.runList.invalidate();
      void utils.admin.sessionList.invalidate();
      void utils.invalidate();
    },
    onError: errToast('common.error'),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 flex-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 text-old-body ring-hairline"
        />
        <button
          type="button"
          onClick={() => setTab('orders')}
          className={
            'press rounded-[var(--r-pill)] px-3 py-1.5 text-old-label font-medium ring-hairline ' +
            (tab === 'orders'
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-transparent text-[var(--c-fg-muted)]')
          }
        >
          {i18n.t('ops.purge.tabOrders')}
        </button>
        <button
          type="button"
          onClick={() => setTab('runs')}
          className={
            'press rounded-[var(--r-pill)] px-3 py-1.5 text-old-label font-medium ring-hairline ' +
            (tab === 'runs'
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-transparent text-[var(--c-fg-muted)]')
          }
        >
          {i18n.t('ops.purge.tabRuns')}
        </button>
      </div>

      {tab === 'orders' ? (
        <DataState
          query={sessionsQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <EmptyState
              title={i18n.t('ops.purge.noSessionsTitle')}
              description={i18n.t('ops.purge.noSessionsBody', { date })}
            />
          }
        >
          {(rows) => (
            <ul className="flex flex-col gap-1.5" role="list">
              {rows.map((sess) => {
                const inRun = sess.status === 'in_run' || sess.status === 'archived' || sess.runId;
                const attribLabel = sess.attribDisplayName ?? 'unattributed';
                const label = `${sess.storeName ?? 'unknown store'} · ${attribLabel}`;
                return (
                  <li
                    key={sess.sessionId}
                    className="flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-old-body font-semibold text-[var(--c-fg)]">
                          {label}
                        </span>
                        {sess.isMine ? (
                          <Badge tone="info">{i18n.t('admin.label.you')}</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                        {i18n.t('ops.purge.sessionMeta', {
                          status: i18n.t(
                            ('order.status.' +
                              (sess.status === 'rejected'
                                ? 'rejectedTitle'
                                : sess.status)) as Parameters<typeof i18n.t>[0],
                          ),
                          items: i18n.t('run.label.itemsCount', { n: sess.itemCount }),
                          date: sess.orderDate,
                        })}
                      </div>
                    </div>
                    {inRun ? (
                      <span className="text-old-tiny text-[var(--c-fg-muted)]">in&nbsp;run</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setSessionTarget({
                            sessionId: sess.sessionId,
                            label,
                          });
                          sessionDryRun.mutate({
                            sessionId: sess.sessionId,
                            dryRun: true,
                          });
                        }}
                      >
                        {i18n.t('common.delete')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      ) : (
        <DataState
          query={runsQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <EmptyState
              title={i18n.t('ops.purge.noRunsTitle')}
              description={i18n.t('ops.purge.noRunsBody', { date })}
            />
          }
        >
          {(rows) => (
            <ul className="flex flex-col gap-1.5" role="list">
              {rows.map((r) => {
                const label = `Run ${r.runDate} #${r.runIndex + 1}`;
                return (
                  <li
                    key={r.runId}
                    className="flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-old-body font-semibold text-[var(--c-fg)]">
                          {label}
                        </span>
                        {r.purchaserIsMe ? (
                          <Badge tone="info">{i18n.t('admin.label.you')}</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                        {i18n.t('ops.purge.runMeta', {
                          status: i18n.t(
                            ('run.status.' + r.status) as Parameters<typeof i18n.t>[0],
                          ),
                          sessions: i18n.t('run.label.sessionsCount', {
                            n: r.sessionCount,
                          }),
                        })}
                        {r.purchaserDisplayName ? ` · by ${r.purchaserDisplayName}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setRunTarget({ runId: r.runId, label });
                        runDryRun.mutate({
                          runId: r.runId,
                          dryRun: true,
                          requireOnlyTestSessions: true,
                        });
                      }}
                    >
                      {i18n.t('common.delete')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      )}

      {/* ---- Session-purge confirmation sheet ---- */}
      <Sheet
        open={!!sessionTarget}
        onOpenChange={(o) => !o && !sessionCommit.isPending && setSessionTarget(null)}
        title={`Delete order session`}
        description={sessionTarget?.label}
        footer={
          <Button
            block
            variant="danger"
            loading={sessionCommit.isPending}
            disabled={!sessionTarget?.preview || sessionTarget.preview.total === 0}
            onClick={() => {
              if (!sessionTarget) return;
              sessionCommit.mutate({
                sessionId: sessionTarget.sessionId,
                dryRun: false,
              });
            }}
          >
            {sessionCommit.isPending
              ? 'Deleting…'
              : sessionTarget?.preview
                ? `Delete ${sessionTarget.preview.total} rows`
                : 'Loading preview…'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {sessionDryRun.isPending ? (
            <div className="flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]">
              <Spinner size={14} /> Counting…
            </div>
          ) : sessionTarget?.preview ? (
            <CascadePreview
              byTable={sessionTarget.preview.byTable}
              total={sessionTarget.preview.total}
            />
          ) : null}
        </div>
      </Sheet>

      {/* ---- Run-purge confirmation sheet ---- */}
      <Sheet
        open={!!runTarget}
        onOpenChange={(o) => !o && !runCommit.isPending && setRunTarget(null)}
        title={i18n.t('ops.purge.deleteRunTitle')}
        description={runTarget?.label}
        footer={
          <Button
            block
            variant="danger"
            loading={runCommit.isPending}
            disabled={!runTarget?.preview || runTarget.preview.total === 0}
            onClick={() => {
              if (!runTarget) return;
              runCommit.mutate({
                runId: runTarget.runId,
                dryRun: false,
                requireOnlyTestSessions: true,
              });
            }}
          >
            {runCommit.isPending
              ? 'Deleting…'
              : runTarget?.preview
                ? `Delete ${runTarget.preview.total} rows`
                : 'Loading preview…'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {runDryRun.isPending ? (
            <div className="flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]">
              <Spinner size={14} /> Counting…
            </div>
          ) : runTarget?.preview ? (
            <>
              <Banner tone="warn" title={i18n.t('ops.purge.cascadeTitle')}>
                {i18n.t('ops.purge.cascadeBody', {
                  n: runTarget.preview.sessionIds.length,
                })}
              </Banner>
              <CascadePreview byTable={runTarget.preview.byTable} total={runTarget.preview.total} />
            </>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}

function CascadePreview({ byTable, total }: { byTable: Record<string, number>; total: number }) {
  return (
    <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
      <div className="text-old-body font-semibold text-[var(--c-fg)]">
        {total} rows would be deleted
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {Object.entries(byTable)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([table, n]) => (
            <li
              key={table}
              className="flex justify-between font-mono text-old-label text-[var(--c-fg-muted)]"
            >
              <span className="truncate">{table}</span>
              <span className="tabular-nums">{n}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Admin audit log (added 2026-05-05).
 *
 * Renders rows from `domain.policy_decisions`, which now gets a row
 * for every catalog/role/permission mutation an admin runs (see
 * `auditAdmin()` helper in apps/api/src/trpc/routers/admin.ts).
 *
 * Display goal: a busy chain owner should be able to skim "what
 * happened in the last hour" and answer:
 *   - Who changed this SKU?
 *   - Who promoted Ali to manager?
 *   - When did Aziz get the `order.approve` override?
 *
 * The action keys we currently emit are:
 *   admin.store.{create|update|delete}
 *   admin.category.{create|update|delete}
 *   admin.sku.{create|update|delete}
 *   admin.supplier.{create|update|delete}
 *   admin.role.{create|update|delete}
 *   admin.memberPermission.{allow|deny|revoke}
 */
export function AdminAuditSection() {
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  // B2 (2026-05-06): per-store filter. The pill row at the top lets an
  // admin scope the log to one store; rows pre-2026-05-06 (NULL scope)
  // disappear under the filter, which is correct — they predate the
  // column.
  const session = useAuthStore((s) => s.session);
  const sessionStores = session?.stores ?? [];
  // M1.9 (2026-05-07): the raw `JSON.stringify(r.inputs)` payload
  // preview looks like a debugger artifact to a non-technical chain
  // owner. Hide for everyone-but-super-admin so the verb+actor+time
  // line stays clean. Forensics still available via the DB row for
  // anyone with shell access.
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const auditQuery = trpc.admin.adminAuditList.useQuery({
    limit: PAGE_SIZE.list,
    ...(storeFilter ? { storeId: storeFilter } : {}),
  });
  const storeNameById = useMemo(
    () => new Map(sessionStores.map((s) => [s.id, s.name])),
    [sessionStores],
  );
  return (
    <div className="px-4 py-3">
      {/* Filter chip row — only renders when there's something to
          filter. Single-store users see one chip + "all". */}
      {sessionStores.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setStoreFilter(null)}
            className={
              'rounded-full px-3 py-1 text-old-label font-medium ring-hairline ' +
              (storeFilter === null
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
            }
          >
            {i18n.t('ops.audit.allScopes')}
          </button>
          {sessionStores.map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => setStoreFilter(st.id)}
              className={
                'rounded-full px-3 py-1 text-old-label font-medium ring-hairline ' +
                (storeFilter === st.id
                  ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                  : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
              }
            >
              {st.name}
            </button>
          ))}
        </div>
      ) : null}
      <DataState
        query={auditQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={
              storeFilter
                ? `No actions in 🏪 ${storeNameById.get(storeFilter) ?? 'this store'}`
                : 'No admin actions yet'
            }
            description={
              storeFilter
                ? "Older audit rows predate the per-store column and don't appear under a store filter."
                : 'Catalog edits and role changes will appear here as they happen.'
            }
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((r) => {
              // Derive a friendly verb + object from the action key.
              // E.g. "admin.sku.update" → ["sku", "updated"].
              const parts = r.action.split('.');
              const obj = parts[1] ?? '?';
              const verb = parts[2] ?? '?';
              const tone =
                verb === 'delete' || verb === 'deny'
                  ? 'danger'
                  : verb === 'allow' || verb === 'create'
                    ? 'success'
                    : 'muted';
              // 2026-07-30: `undefined` meant "browser locale".
              const when = dateFmt.dateTime(r.occurredAt);
              return (
                <Card key={r.id}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge tone={tone}>{verb}</Badge>
                        <span className="text-old-body font-semibold text-[var(--c-fg)]">
                          {obj}
                        </span>
                        {r.resourceId ? (
                          <span className="font-mono text-old-label text-[var(--c-fg-muted)]">
                            {r.resourceId.slice(0, 8)}…
                          </span>
                        ) : null}
                        {/* B2: store-scope chip per row.
                            M3.17 (2026-05-16): inline span → <Badge>. */}
                        {r.scopeStoreId ? (
                          <Badge tone="muted">
                            {storeNameById.get(r.scopeStoreId) ?? r.scopeStoreId.slice(0, 8)}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-old-label text-[var(--c-fg-muted)]">
                        {r.actor?.displayName ?? 'unknown'}
                        {r.actor?.tgUsername ? ` · @${r.actor.tgUsername}` : ''}
                        {' · '}
                        {when}
                      </div>
                      {/* Lightweight payload preview — JSON.stringify
                          fits one line for most actions; long inputs
                          are truncated since the full row is in the DB
                          for forensics. M1.9: super_admin only — looks
                          like a debugger artifact to non-tech users. */}
                      {isSuperAdmin ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-old-label font-medium text-[var(--c-fg-muted)]">
                            {i18n.t('ops.audit.inputs')}
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2 py-1 font-mono text-old-label text-[var(--c-fg-muted)]">
                            {JSON.stringify(r.inputs, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
    </div>
  );
}

export function MaintenanceSection() {
  const session = useAuthStore((s) => s.session);
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();

  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  const orgSlug = session?.member.orgSlug ?? '';

  // ---- by-date purge state ----
  const [dateInput, setDateInput] = useState<string>(todayIso());
  const [datePreview, setDatePreview] = useState<{
    date: string;
    total: number;
    byTable: Record<string, number>;
  } | null>(null);
  const [dateConfirmOpen, setDateConfirmOpen] = useState(false);

  const datePreviewMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      setDatePreview({ date: data.date, total: data.total, byTable: data.byTable });
      setDateConfirmOpen(true);
    },
    onError: errToast('common.error'),
  });
  const dateCommitMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.dateReset', { date: data.date, n: data.total }));
      setDateConfirmOpen(false);
      setDatePreview(null);
      void utils.invalidate();
    },
    onError: errToast('common.error'),
  });

  // ---- nuclear-purge state ----
  const [confirmText, setConfirmText] = useState('');
  const [allOpen, setAllOpen] = useState(false);
  const slugMatches = confirmText === orgSlug;
  const allDryRun = trpc.admin.purgeAllTestData.useMutation({
    onError: errToast('common.error'),
  });
  const allCommit = trpc.admin.purgeAllTestData.useMutation({
    onSuccess: (data) => {
      toast.success(
        i18n.t('admin.toast.dataPurged', {
          n: data.total,
          tables: Object.keys(data.byTable).length,
        }),
      );
      setAllOpen(false);
      setConfirmText('');
      void utils.invalidate();
    },
    onError: errToast('common.error'),
  });

  if (!isSuperAdmin) {
    return (
      <div className="px-4 py-3">
        <Banner tone="warn" title={i18n.t('ops.maint.superOnlyTitle')}>
          {i18n.t('ops.maint.superOnlyBody')}
        </Banner>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      {/* ============ Surgical: pick a single test session/run ============ */}
      <Card>
        <div className="flex flex-col gap-3 px-4 py-4">
          <div>
            <div className="text-old-h2 font-semibold text-[var(--c-fg)]">
              {i18n.t('ops.maint.targetedTitle')}
            </div>
            <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">
              {i18n.t('ops.maint.targetedBody')}
            </p>
          </div>
          <TargetedPurgeBrowser />
        </div>
      </Card>

      {/* ============ Reset today (still useful when nothing real yet) ============ */}
      <div className="mt-3">
        <Card>
          <div className="flex flex-col gap-3 px-4 py-4">
            <div>
              <div className="text-old-h2 font-semibold text-[var(--c-fg)]">
                {i18n.t('ops.maint.resetTodayTitle')}
              </div>
              <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">
                {i18n.t('ops.maint.resetTodayBody', { date: todayIso() })}
              </p>
            </div>
            <Button
              size="sm"
              variant="pearl"
              loading={datePreviewMut.isPending}
              onClick={() => datePreviewMut.mutate({ date: todayIso(), dryRun: true })}
            >
              {i18n.t('ops.maint.resetToday')}
            </Button>
          </div>
        </Card>
      </div>

      {/* ============ Reset another date ============ */}
      <div className="mt-3">
        <Card>
          <div className="flex flex-col gap-3 px-4 py-4">
            <div>
              <div className="text-old-h2 font-semibold text-[var(--c-fg)]">
                {i18n.t('ops.maint.resetDateTitle')}
              </div>
              <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">
                {i18n.t('ops.maint.resetDateBody')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className="h-11 flex-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-old-h3 ring-hairline"
              />
              <Button
                size="sm"
                variant="pearl"
                loading={datePreviewMut.isPending}
                disabled={!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)}
                onClick={() => datePreviewMut.mutate({ date: dateInput, dryRun: true })}
              >
                {i18n.t('ops.maint.preview')}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* ============ Nuclear option ============ */}
      <div className="mt-6">
        <Banner tone="danger" title={i18n.t('ops.maint.wipeTitle')}>
          {i18n.t('ops.maint.wipeBody')}
        </Banner>
        <div className="mt-3">
          <Card>
            <div className="flex flex-col gap-3 px-4 py-4">
              <div>
                <div className="text-old-h2 font-semibold text-[var(--c-fg)]">
                  {i18n.t('ops.maint.purgeAllTitle')}
                </div>
                <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">
                  {i18n.t('ops.maint.purgeAllBody')}
                </p>
              </div>
              <Button
                size="sm"
                variant="pearl"
                loading={allDryRun.isPending}
                onClick={() => {
                  allDryRun.mutate({ dryRun: true }, { onSuccess: () => setAllOpen(true) });
                }}
              >
                {i18n.t('ops.maint.previewEverything')}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {/* ============ Date-purge confirm sheet ============ */}
      <Sheet
        open={dateConfirmOpen}
        onOpenChange={(o) => !o && !dateCommitMut.isPending && setDateConfirmOpen(false)}
        title={i18n.t('ops.maint.resetSheetTitle', { date: datePreview?.date ?? '' })}
        description={i18n.t('ops.maint.resetSheetBody')}
        footer={
          <Button
            block
            variant="danger"
            loading={dateCommitMut.isPending}
            disabled={!datePreview || datePreview.total === 0}
            onClick={() => {
              if (!datePreview) return;
              dateCommitMut.mutate({ date: datePreview.date, dryRun: false });
            }}
          >
            {dateCommitMut.isPending
              ? 'Resetting…'
              : datePreview && datePreview.total > 0
                ? `Delete ${datePreview.total} rows`
                : 'Nothing to delete'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {datePreview ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {datePreview.total === 0
                  ? `Nothing on ${datePreview.date} — already clean.`
                  : `${datePreview.total} rows from ${datePreview.date}`}
              </div>
              {datePreview.total > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {Object.entries(datePreview.byTable)
                    .filter(([, n]) => n > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([table, n]) => (
                      <li
                        key={table}
                        className="flex justify-between font-mono text-old-label text-[var(--c-fg-muted)]"
                      >
                        <span className="truncate">{table}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </Sheet>

      {/* ============ Nuclear-purge confirm sheet ============ */}
      <Sheet
        open={allOpen}
        onOpenChange={(o) => !o && !allCommit.isPending && setAllOpen(false)}
        title={i18n.t('ops.maint.confirmPurgeTitle')}
        description={i18n.t('ops.maint.confirmPurgeBody', { slug: orgSlug })}
        footer={
          <Button
            block
            variant="danger"
            loading={allCommit.isPending}
            disabled={!slugMatches}
            onClick={() => {
              if (!slugMatches) return;
              allCommit.mutate({ dryRun: false, confirmText });
            }}
          >
            {allCommit.isPending ? 'Purging…' : `Delete ${allDryRun.data?.total ?? 0} rows`}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {allDryRun.data ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {allDryRun.data.total} rows would be deleted
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {Object.entries(allDryRun.data.byTable)
                  .filter(([, n]) => n > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([table, n]) => (
                    <li
                      key={table}
                      className="flex justify-between font-mono text-old-label text-[var(--c-fg-muted)]"
                    >
                      <span className="truncate">{table}</span>
                      <span className="tabular-nums">{n}</span>
                    </li>
                  ))}
              </ul>
              {allDryRun.data.total === 0 ? (
                <p className="mt-2 text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('ops.maint.nothingToPurge')}
                </p>
              ) : null}
            </div>
          ) : null}

          <Field label={`Type "${orgSlug}" to confirm`}>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={orgSlug}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
        </div>
      </Sheet>
    </div>
  );
}

// Field helper removed — imported from @compass/ui.
