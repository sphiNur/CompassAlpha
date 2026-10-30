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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Segmented,
  Select,
  Sheet,
  Spinner,
  Tile,
  useToast,
} from '@compass/ui';
import { PAGE_SIZE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../../../hooks/useI18n';
import { DebugPage } from '../../DebugPage';
import { financePresetRange, maintenanceToday } from './financeDates';
import { auditCategory, describeAuditRow, type AuditCategory } from './auditSentence';

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

      <h2 className="mt-6 mb-2 text-old-h2 font-semibold text-[var(--c-fg)]">{i18n.t('ops.activity.recentEvents')}</h2>
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
                ? 'bg-[var(--c-warn-bg)]'
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
                          ? i18n.t('ops.activity.claimOverride')
                          : claimReason === 'timeout'
                            ? i18n.t('ops.activity.claimTimeout')
                            : undefined
                      }
                    >
                      {e.streamType}.{e.type}
                      {claimReason ? (
                        <span
                          className={
                            isIntervention
                              ? 'ml-1.5 text-old-tiny font-medium uppercase tracking-wider text-[var(--c-warn-ink)]'
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
 * Per-store timeline of submitted orders with outcome + per-contributor
 * breakdown. Read-only — this is the "what did we do recently?" view
 * for managers and admins. Default range: last 30 days.
 */
export function HistorySection() {
  const i18n = useI18n();
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const stores = trpc.admin.storeList.useQuery();
  const history = trpc.admin.submissionHistory.useQuery({
    storeId: storeFilter ?? undefined,
    limit: PAGE_SIZE.list,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        <Select value={storeFilter ?? ''} onChange={(e) => setStoreFilter(e.target.value || null)}>
          <option value="">{i18n.t('ops.history.allStores')}</option>
          {(stores.data ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </Select>
      </div>
      <DataState
        query={history}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('ops.history.emptyTitle')}
            description={i18n.t('ops.history.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((r) => {
              const isOpen = openId === r.sessionId;
              const statusTone =
                r.status === 'approved' || r.status === 'in_run' || r.status === 'archived'
                  ? 'success'
                  : r.status === 'rejected'
                    ? 'danger'
                    : 'info';
              return (
                <Card key={r.sessionId}>
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : r.sessionId)}
                    className="press w-full text-left"
                  >
                    <CardHeader>
                      <div className="min-w-0">
                        <CardTitle>{r.storeName ?? r.storeId.slice(0, 8)}</CardTitle>
                        <CardMeta>
                          {r.orderDate}
                          {r.submittedAt
                            ? ` · ${i18n.t('ops.history.submittedAgo', {
                                when: formatRelative(r.submittedAt, i18n),
                              })}`
                            : ''}
                          {r.submittedByName
                            ? ` ${i18n.t('ops.history.byWhom', { name: r.submittedByName })}`
                            : ''}
                        </CardMeta>
                      </div>
                      <Badge tone={statusTone}>
                        {i18n.t(
                          ('order.status.' +
                            (r.status === 'rejected' ? 'rejectedTitle' : r.status)) as Parameters<
                            typeof i18n.t
                          >[0],
                        )}
                      </Badge>
                    </CardHeader>
                  </button>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-old-label text-[var(--c-fg-muted)]">
                    <span>
                      {i18n.t('ops.history.skuTotalLine', {
                        n: r.skuCount,
                        total: formatQty(r.totalQty),
                      })}
                    </span>
                    {r.contributors.length > 0 ? (
                      <span>
                        ·{' '}
                        {i18n.t('ops.history.contributorCount', {
                          n: r.contributors.length,
                        })}
                      </span>
                    ) : null}
                    {r.reviewMinutes !== null ? (
                      <span>{i18n.t('ops.history.decidedIn', { n: r.reviewMinutes })}</span>
                    ) : null}
                    {r.decidedByName ? (
                      <span>{i18n.t('ops.history.decidedBy', { name: r.decidedByName })}</span>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <div className="border-t border-[var(--c-divider)] px-4 py-2">
                      <SectionLabel padded={false}>
                        {i18n.t('ops.history.contributorBreakdown')}
                      </SectionLabel>
                      <ul className="mt-2 flex flex-col gap-1">
                        {r.contributors.map((c) => (
                          <li
                            key={c.memberId}
                            className="flex items-baseline justify-between text-old-body"
                          >
                            <span className="truncate text-[var(--c-fg)]">
                              {c.displayName ?? c.memberId.slice(0, 6)}
                            </span>
                            <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                              {i18n.t('ops.history.skuCount', { n: c.skuCount })} · {formatQty(c.totalQty)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {r.rejectReason ? (
                        <p className="mt-3 text-old-label text-[var(--c-danger)]">
                          {i18n.t('ops.history.rejectionReason', {
                            reason: r.rejectReason,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
    </div>
  );
}

/**
 * Relative "how long ago" label.
 *
 * 2026-07-30: took the i18n instance as a parameter rather than reading a hook,
 * so it stays a pure function (callers are inside components that already have
 * `i18n`). Previously returned hardcoded English — "just now" / "3m ago" —
 * inside an otherwise Chinese activity feed.
 */
function formatRelative(iso: string, i18n: ReturnType<typeof useI18n>): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return i18n.t('time.justNow');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return i18n.t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  return i18n.t('time.daysAgo', { n: days });
}

// ============ Maintenance ============

// 2026-10-21 FE-07: local calendar date — the UTC slice made "reset
// today" purge YESTERDAY east of UTC before the offset hour.
function todayIso(): string {
  return maintenanceToday();
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
                      <span className="text-old-tiny text-[var(--c-fg-muted)]">
                        {i18n.t('ops.purge.inRun')}
                      </span>
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
                const label = i18n.t('ops.purge.runLabel', { date: r.runDate, n: r.runIndex + 1 });
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
                        {r.purchaserDisplayName
                          ? ` ${i18n.t('ops.history.decidedBy', { name: r.purchaserDisplayName })}`
                          : ''}
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
        title={i18n.t('ops.purge.deleteSessionTitle')}
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
              ? i18n.t('ops.purge.deleting')
              : sessionTarget?.preview
                ? i18n.t('ops.purge.deleteRows', { n: sessionTarget.preview.total })
                : i18n.t('ops.purge.counting')}
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
              ? i18n.t('ops.purge.deleting')
              : runTarget?.preview
                ? i18n.t('ops.purge.deleteRows', { n: runTarget.preview.total })
                : i18n.t('ops.purge.counting')}
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
  const i18n = useI18n();
  return (
    <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
      <div className="text-old-body font-semibold text-[var(--c-fg)]">
        {i18n.t('ops.purge.rowsWouldBeDeleted', { n: total })}
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
  const productName = useProductName();
  // B2 (2026-05-06): per-store filter. The pill row at the top lets an
  // admin scope the log to one store; rows pre-2026-05-06 (NULL scope)
  // disappear under the filter, which is correct — they predate the
  // column.
  const session = useAuthStore((s) => s.session);
  const sessionStores = session?.stores ?? [];
  // ADM-16: the server only returns rows for stores the actor administers,
  // so a store they merely work in was a filter that always came up empty.
  const adminStoreIds = new Set(session?.adminStoreIds ?? []);
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
  const categoryLabel: Record<AuditCategory | 'all', string> = {
    all: i18n.t('order.categories.all'),
    people: i18n.t('admin.tile.members'),
    roles: i18n.t('admin.section.permissions'),
    stores: i18n.t('admin.section.stores'),
    catalog: i18n.t('admin.section.catalog'),
    other: i18n.t('settlement.expenseCategory.other'),
  };
  // Catalog rows get a per-kind badge (SKUs / Suppliers …) instead of
  // the generic "Catalog".
  const kindLabel: Record<string, string> = {
    sku: i18n.t('admin.subsection.skus'),
    category: i18n.t('admin.subsection.categories'),
    supplier: i18n.t('admin.subsection.suppliers'),
    expenseTemplate: i18n.t('admin.subsection.expenseTemplates'),
    dish: i18n.t('admin.subsection.dishes'),
  };
  const chipClass = (active: boolean) =>
    'rounded-full px-3 py-1 text-old-label font-medium ring-hairline ' +
    (active
      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
      : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]');
  return (
    <div className="px-4 py-3">
      {/* Filter chip row — only renders when there's something to
          filter. Single-store users see one chip + "all". */}
      {filterStores.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setStoreFilter(null)}
            aria-pressed={storeFilter === null}
            className={chipClass(storeFilter === null)}
          >
            {i18n.t('ops.audit.allScopes')}
          </button>
          {filterStores.map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => setStoreFilter(st.id)}
              aria-pressed={storeFilter === st.id}
              className={chipClass(storeFilter === st.id)}
            >
              {st.name}
            </button>
          ))}
        </div>
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
            <ul className="flex flex-col gap-2" role="list">
              {rows.map((r) => {
                // 2026-10-21 FE-08: one readable sentence per row ("A
                // granted Manager to B") from server-resolved names,
                // instead of raw verb/object words and id prefixes.
                const s = describeAuditRow(r, {
                  unknown: i18n.t('ops.audit.unknown'),
                  localName: (names) => productName({ names }),
                });
                const badge =
                  s.category === 'catalog'
                    ? (kindLabel[s.object] ?? s.object)
                    : categoryLabel[s.category];
                // Store chip: the resolved name, else the session's store
                // list, else the id prefix (B2 / M3.17).
                const storeChip = r.scopeStoreId
                  ? (storeNameById.get(r.scopeStoreId) ??
                    r.labels.storeName ??
                    r.scopeStoreId.slice(0, 8))
                  : null;
                // 2026-07-30: `undefined` meant "browser locale".
                const when = dateFmt.dateTime(r.occurredAt);
                return (
                  <Card key={r.id}>
                    <div className="flex items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <Badge tone={s.tone}>{badge}</Badge>
                          {storeChip ? <Badge tone="muted">🏪 {storeChip}</Badge> : null}
                        </div>
                        <div className="mt-1 text-old-body text-[var(--c-fg)]">
                          {i18n.t(s.key, s.params)}
                        </div>
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
                            <summary className="cursor-pointer text-old-label font-medium text-[var(--c-fg-muted)]">
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
                  </Card>
                );
              })}
            </ul>
          );
        }}
      </DataState>
    </div>
  );
}

/**
 * Price report (added 2026-05-05).
 *
 * Per-SKU table:
 *   - last price seen (with date)
 *   - 7-day mean
 *   - 30-day mean
 *   - delta (last vs 30-day mean) so admin can spot outliers
 *
 * Reads `catalog.skuPriceStats` once for ALL SKUs in the org (no
 * skuIds filter) plus `catalog.skus` for names. Sort: highest 30d mean
 * first — most expensive items are usually the ones the user cares
 * about budgeting.
 *
 * Why this exists: the user wants "use yesterday's prices to budget
 * for tomorrow's purchase". The OrderPage review sheet now uses
 * 7-day avg automatically (downstream of the same endpoint), but
 * admins also want a standalone view to spot anomalies and trends.
 */
export function PriceReportSection() {
  const i18n = useI18n();
  const productName = useProductName();
  // 2026-07-30 (flow review): the "/ unit" suffix printed the raw canonical
  // unit next to a localized product name.
  const unitLabel = useUnitLabel();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  // No skuIds filter → return all SKUs with observations in 30 days.
  const statsQuery = trpc.catalog.skuPriceStats.useQuery();

  const skuById = useMemo(() => {
    const m = new Map<string, { id: string; names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
      });
    }
    return m;
  }, [skusQuery.data]);

  const rows = useMemo(() => {
    const stats = statsQuery.data ?? [];
    return stats
      .map((r) => {
        const sku = skuById.get(r.skuId);
        const name = sku ? productName({ names: sku.names }) : r.skuId.slice(0, 8);
        const last = r.lastPrice ? Number(r.lastPrice) : null;
        const avg30 = r.avg30d ? Number(r.avg30d) : null;
        // Delta = (last − avg30) / avg30, signed. Used for the trend
        // arrow + tone. Skip when either side is unknown.
        const deltaPct =
          last !== null && avg30 && avg30 > 0 ? ((last - avg30) / avg30) * 100 : null;
        return {
          skuId: r.skuId,
          name,
          unit: sku?.unit ?? '',
          last,
          lastObservedAt: r.lastObservedAt,
          avg7d: r.avg7d ? Number(r.avg7d) : null,
          avg30d: avg30,
          observations: r.observations30d,
          deltaPct,
        };
      })
      .sort((a, b) => (b.avg30d ?? 0) - (a.avg30d ?? 0));
  }, [statsQuery.data, skuById, productName]);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title={i18n.t('ops.price.howTitle')}>
        {i18n.t('ops.price.howBody')}
      </Banner>
      {statsQuery.isLoading || skusQuery.isLoading ? (
        <div className="mt-4">
          <Spinner size={16} />
        </div>
      ) : statsQuery.isError || skusQuery.isError ? (
        // 2026-10-21 FE-01 (F6-04): a failed query used to fall through
        // to "no price data yet". DataState renders the translated error
        // + Retry; the children branch is unreachable here.
        <div className="mt-3">
          <DataState
            query={{
              data: undefined,
              isLoading: false,
              isError: true,
              isFetching: statsQuery.isFetching || skusQuery.isFetching,
              error: statsQuery.error ?? skusQuery.error,
              refetch: () => {
                if (statsQuery.isError) void statsQuery.refetch();
                if (skusQuery.isError) void skusQuery.refetch();
              },
            }}
          >
            {() => null}
          </DataState>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={i18n.t('ops.price.emptyTitle')}
          description={i18n.t('ops.price.emptyBody')}
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-1" role="list">
          {rows.map((r) => {
            const tone =
              r.deltaPct === null
                ? 'muted'
                : Math.abs(r.deltaPct) < 5
                  ? 'muted'
                  : r.deltaPct > 0
                    ? 'danger'
                    : 'success';
            const arrow =
              r.deltaPct === null ? '·' : r.deltaPct > 0 ? '▲' : r.deltaPct < 0 ? '▼' : '·';
            const deltaLabel =
              r.deltaPct === null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
            return (
              <li
                key={r.skuId}
                className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-old-body font-semibold text-[var(--c-fg)]">
                    {r.name}
                  </span>
                  <span className="font-mono text-old-body tabular-nums text-[var(--c-fg)]">
                    {r.last !== null ? formatMoney(r.last) : '—'}{' '}
                    <span className="text-old-label font-normal text-[var(--c-fg-muted)]">
                      / {unitLabel(r.unit)}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-3 text-old-label text-[var(--c-fg-muted)]">
                  <span>
                    {i18n.t('ops.price.avg7d')}{' '}
                    <span className="font-mono tabular-nums text-[var(--c-fg)]">
                      {r.avg7d !== null ? formatMoney(r.avg7d) : '—'}
                    </span>
                  </span>
                  <span>
                    {i18n.t('ops.price.avg30d')}{' '}
                    <span className="font-mono tabular-nums text-[var(--c-fg)]">
                      {r.avg30d !== null ? formatMoney(r.avg30d) : '—'}
                    </span>
                  </span>
                  <span>{i18n.t('ops.price.observations', { n: r.observations })}</span>
                  <Badge tone={tone}>
                    {arrow} {deltaLabel}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ============ Finance reconciliation (M1.15) ============
//
// Three views over the same data set (purchaseLines):
//   - Daily: per-day totals (cash + transfer) for the picked range,
//     plus an expandable per-day SKU breakdown.
//   - By supplier: rolled up totals per supplier, with cash/transfer
//     split. Empty supplier_id bucketed as "—".
//   - By store: rolled up totals per destination store.
//
// Date picker presets: today / yesterday / this month / last month /
// custom. The picked range is the input for ALL three tabs (they
// share the same underlying purchaseLines query, just regrouped client
// side). This keeps the API surface small (M1.14 + M1.15 introduced
// only one tRPC namespace: `report`).
//
// Permissions: `users.manage` (Admin gate). A future M1.x can split
// out `finance.view` for accounting-only Telegram accounts.

type FinanceView = 'daily' | 'bySupplier' | 'byStore';
type FinancePreset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom';

export function FinanceSection() {
  const i18n = useI18n();
  const toast = useToast();
  const productName = useProductName();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  // HIS-19: names only, and readable by finance readers who are not
  // admins; archived stalls keep their names in old periods.
  const suppliersQuery = trpc.catalog.suppliers.useQuery({ includeArchived: true });
  // HIS-19: the stores finance covers (reports.view ∪ users.manage).
  const storesQuery = trpc.catalog.stores.useQuery({ permission: 'finance' });

  // Date range. Default to "this month" since that's the most common
  // reconciliation cadence (monthly bank statement vs. cash drawer
  // closing). Custom range lets the user widen / narrow on demand.
  // 2026-10-21 audit CA-23 (D-05): presets read the LOCAL calendar via
  // financePresetRange — `toISOString()` shifted them a day east of UTC.
  // HIS-13 (2026-10-30): the org's calendar, not the device's — a phone set
  // to UTC turned Tashkent's "today" into yesterday until 05:00.
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [preset, setPreset] = useState<FinancePreset>('thisMonth');
  const [startDate, setStartDate] = useState<string>(
    () => financePresetRange('thisMonth', new Date(), orgTimeZone).startDate,
  );
  const [endDate, setEndDate] = useState<string>(
    () => financePresetRange('thisMonth', new Date(), orgTimeZone).endDate,
  );

  // Apply preset → derive [start, end]. Custom keeps whatever the user
  // typed in the two inputs.
  useEffect(() => {
    if (preset === 'custom') return;
    const range = financePresetRange(preset, new Date(), orgTimeZone);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }, [preset]);

  const [view, setView] = useState<FinanceView>('daily');

  // HIS-12 (2026-10-30): an empty or reversed custom range used to show
  // "no purchases in this range", or fail three times into "unknown error".
  const rangeOk =
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate;
  const linesQuery = trpc.report.purchaseLines.useQuery(
    { startDate, endDate },
    { enabled: rangeOk },
  );
  const totalsQuery = trpc.report.totals.useQuery({ startDate, endDate }, { enabled: rangeOk });

  // Lookup tables for joining ids → display names.
  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, { names: sku.names as Record<string, string>, unit: sku.unit });
    }
    return m;
  }, [skusQuery.data]);

  const supplierById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliersQuery.data ?? []) m.set(s.id, s.name);
    return m;
  }, [suppliersQuery.data]);

  const storeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of storesQuery.data ?? []) m.set(s.id, s.name);
    return m;
  }, [storesQuery.data]);

  const lines = linesQuery.data ?? [];

  /**
   * 2026-10-21 CA-11: purchaseLines now also carries off-catalog expense
   * splits (`kind: 'expense'`, skuId null, free-text label), so finance
   * shows the same money as History and the finish sheet. One name
   * resolver for both kinds; expenses get a 🧾 marker.
   */
  const lineName = useCallback(
    (l: (typeof lines)[number]): string => {
      if (l.kind === 'expense' || !l.skuId) {
        return `🧾 ${l.label ?? i18n.t('finance.label.expense')}`;
      }
      const sku = skuById.get(l.skuId);
      return sku ? productName({ names: sku.names }) : l.skuId.slice(0, 8);
    },
    [skuById, productName, i18n],
  );
  const lineKey = (l: (typeof lines)[number], i: number) =>
    `${l.runId}-${l.skuId ?? l.expenseId}-${l.storeId}-${i}`;

  // Group by ("YYYY-MM-DD"). Each day → cash sum, transfer sum, line list.
  const dailyGroups = useMemo(() => {
    const m = new Map<
      string,
      { date: string; cash: number; transfer: number; lines: typeof lines }
    >();
    for (const l of lines) {
      const g = m.get(l.runDate) ?? {
        date: l.runDate,
        cash: 0,
        transfer: 0,
        lines: [] as typeof lines,
      };
      const lt = Number(l.lineTotal);
      if (l.paymentMethod === 'transfer') g.transfer += lt;
      else g.cash += lt;
      g.lines.push(l);
      m.set(l.runDate, g);
    }
    return [...m.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [lines]);

  // Group by supplierId (null → '__none' sentinel).
  const supplierGroups = useMemo(() => {
    const m = new Map<
      string,
      {
        key: string;
        supplierId: string | null;
        cash: number;
        transfer: number;
        lines: typeof lines;
      }
    >();
    for (const l of lines) {
      // Expenses have no stall; they get their own group rather than
      // inflating the "no supplier" bucket of unassigned SKU buys.
      const key = l.kind === 'expense' ? '__expense' : (l.supplierId ?? '__none');
      const g = m.get(key) ?? {
        key,
        supplierId: l.kind === 'expense' ? null : l.supplierId,
        cash: 0,
        transfer: 0,
        lines: [] as typeof lines,
      };
      const lt = Number(l.lineTotal);
      if (l.paymentMethod === 'transfer') g.transfer += lt;
      else g.cash += lt;
      g.lines.push(l);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => b.cash + b.transfer - (a.cash + a.transfer));
  }, [lines]);

  // Group by storeId.
  const storeGroups = useMemo(() => {
    const m = new Map<
      string,
      { storeId: string; cash: number; transfer: number; lines: typeof lines }
    >();
    for (const l of lines) {
      const g = m.get(l.storeId) ?? {
        storeId: l.storeId,
        cash: 0,
        transfer: 0,
        lines: [] as typeof lines,
      };
      const lt = Number(l.lineTotal);
      if (l.paymentMethod === 'transfer') g.transfer += lt;
      else g.cash += lt;
      g.lines.push(l);
      m.set(l.storeId, g);
    }
    return [...m.values()].sort((a, b) => b.cash + b.transfer - (a.cash + a.transfer));
  }, [lines]);

  // Expandable rows (per-day or per-supplier). Tracks which group's
  // line list is currently open.
  const [expanded, setExpanded] = useState<string | null>(null);

  // Export as text → clipboard. Telegram WebApp can't easily download
  // files, but every supported client can paste into a Telegram chat.
  // The shape is human-readable + machine-parseable (TSV) so finance
  // can drop it straight into their spreadsheet.
  const exportText = useCallback(() => {
    const lineHeader = 'date\trun\tsku\tstore\tsupplier\tmethod\tqty\tunit_price\ttotal';
    const tsv = [
      `# Finance report ${startDate} → ${endDate}`,
      lineHeader,
      ...lines.map((l) => {
        return [
          l.runDate,
          `#${l.runIndex + 1}`,
          lineName(l),
          storeById.get(l.storeId) ?? l.storeId.slice(0, 8),
          l.supplierId ? (supplierById.get(l.supplierId) ?? l.supplierId.slice(0, 8)) : '—',
          l.paymentMethod,
          l.qty,
          l.unitPrice,
          l.lineTotal,
        ].join('\t');
      }),
    ].join('\n');
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      // HIS-8 (2026-10-30): the write can be refused (no clipboard
      // permission); only claim success once it actually happened.
      navigator.clipboard.writeText(tsv).then(
        () => toast.success(i18n.t('finance.export.copied')),
        () => toast.error(i18n.t('finance.export.noClipboard')),
      );
    } else {
      // Fallback for older WebViews — clipboard API unavailable. We
      // surface a user-facing error toast; the TSV is dropped (the
      // earlier console.log was deleted as part of the production
      // hardening pass — privacy + CSP cleanliness).
      toast.error(i18n.t('finance.export.noClipboard'));
    }
  }, [lines, lineName, storeById, supplierById, startDate, endDate, toast, i18n]);

  return (
    <div className="px-4 py-3">
      {/* Range picker — preset segmented control + two date inputs.
          M3.17 (2026-05-16): preset chips migrated to shared <Segmented>. */}
      <div className="mb-3 flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3">
        <Segmented<'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom'>
          value={preset}
          equalWidth={false}
          options={[
            { value: 'today', label: i18n.t('finance.preset.today') },
            { value: 'yesterday', label: i18n.t('finance.preset.yesterday') },
            { value: 'thisMonth', label: i18n.t('finance.preset.thisMonth') },
            { value: 'lastMonth', label: i18n.t('finance.preset.lastMonth') },
            { value: 'custom', label: i18n.t('finance.preset.custom') },
          ]}
          onChange={setPreset}
          ariaLabel={i18n.t('finance.range.start')}
        />
        {preset === 'custom' ? (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label={i18n.t('finance.range.start')}
            />
            <span className="text-old-body text-[var(--c-fg-muted)]">—</span>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label={i18n.t('finance.range.end')}
            />
          </div>
        ) : (
          <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {startDate} → {endDate}
          </div>
        )}
      </div>

      {/* Totals scorecard.
          2026-10-21 FE-01 (F6-04): a failed totals query used to make the
          card silently vanish; show the error + Retry instead. */}
      {totalsQuery.isError ? (
        <div className="mb-3">
          <DataState query={totalsQuery}>{() => null}</DataState>
        </div>
      ) : totalsQuery.data ? (
        <div className="mb-3 grid grid-cols-3 gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3">
          <div>
            <SectionLabel padded={false}>{i18n.t('run.label.paymentCash')}</SectionLabel>
            <div className="font-mono text-old-h2 font-semibold tabular-nums">
              {formatMoney(totalsQuery.data.totalCash)}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {totalsQuery.data.cashLines} {i18n.t('finance.label.lines')}
            </div>
          </div>
          <div>
            <SectionLabel padded={false}>{i18n.t('run.label.paymentTransfer')}</SectionLabel>
            <div className="font-mono text-old-h2 font-semibold tabular-nums">
              {formatMoney(totalsQuery.data.totalTransfer)}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {totalsQuery.data.transferLines} {i18n.t('finance.label.lines')}
            </div>
          </div>
          <div>
            <SectionLabel padded={false}>Σ {i18n.t('finance.label.total')}</SectionLabel>
            <div className="font-mono text-old-h2 font-semibold tabular-nums">
              {formatMoney(totalsQuery.data.total)}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {totalsQuery.data.runCount} {i18n.t('finance.label.runs')}
            </div>
          </div>
          {/* 2026-10-21 CA-11: total = items + expenses, shown as parts. */}
          <div className="col-span-3 border-t border-[var(--c-divider)] pt-2 text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.money.itemsExpenses', {
              items: formatMoney(totalsQuery.data.itemsTotal),
              expenses: formatMoney(totalsQuery.data.expensesTotal),
            })}
          </div>
        </div>
      ) : null}

      {/* View switcher + export.
          M3.17 (2026-05-16): view toggle migrated to <Segmented>; the
          export button is a real <Button> at sm/pearl. */}
      <div className="mb-2 flex items-center gap-2">
        <Segmented<'daily' | 'bySupplier' | 'byStore'>
          value={view}
          options={[
            { value: 'daily', label: i18n.t('finance.view.daily') },
            { value: 'bySupplier', label: i18n.t('finance.view.bySupplier') },
            { value: 'byStore', label: i18n.t('finance.view.byStore') },
          ]}
          onChange={(next) => {
            setView(next);
            setExpanded(null);
          }}
          className="flex-1"
          ariaLabel={i18n.t('finance.view.daily')}
        />
        <Button
          size="sm"
          variant="pearl"
          onClick={exportText}
          disabled={lines.length === 0}
          aria-label={i18n.t('finance.export.label')}
        >
          {i18n.t('finance.export.label')}
        </Button>
      </div>

      {!rangeOk ? (
        <Banner tone="warn" title={i18n.t('finance.range.invalid')} />
      ) : linesQuery.isLoading ? (
        <div className="py-6 text-center">
          <Spinner size={16} />
        </div>
      ) : linesQuery.isError ? (
        // 2026-10-21 FE-01 (F6-04): was rendered as "no expenses".
        <DataState query={linesQuery}>{() => null}</DataState>
      ) : lines.length === 0 ? (
        <EmptyState
          title={i18n.t('finance.empty.title')}
          description={i18n.t('finance.empty.description')}
        />
      ) : view === 'daily' ? (
        <ul className="flex flex-col gap-1" role="list">
          {dailyGroups.map((g) => {
            const isOpen = expanded === g.date;
            const mixed = g.cash > 0 && g.transfer > 0;
            return (
              <li
                key={g.date}
                className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : g.date)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left active:opacity-80"
                >
                  <span className="text-old-body font-semibold tabular-nums">{g.date}</span>
                  <span className="font-mono text-old-body tabular-nums">
                    {formatMoney(g.cash + g.transfer)}
                  </span>
                </button>
                {mixed ? (
                  <div className="flex items-baseline gap-3 px-3 pb-1.5 text-old-label text-[var(--c-fg-muted)]">
                    <span>
                      {i18n.t('run.label.paymentCash')} {formatMoney(g.cash)}
                    </span>
                    <span>
                      {i18n.t('run.label.paymentTransfer')} {formatMoney(g.transfer)}
                    </span>
                  </div>
                ) : null}
                {isOpen ? (
                  <ul className="flex flex-col border-t border-[var(--c-divider)]" role="list">
                    {g.lines.map((l, i) => {
                      const skuName = lineName(l);
                      const supplier = l.supplierId ? (supplierById.get(l.supplierId) ?? '—') : '—';
                      const store = storeById.get(l.storeId) ?? l.storeId.slice(0, 8);
                      return (
                        <li
                          key={lineKey(l, i)}
                          className="flex flex-col gap-0.5 border-b border-[var(--c-divider)] px-3 py-2 last:border-b-0"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-old-body font-medium">
                              {l.paymentMethod === 'transfer'
                                ? i18n.t('run.label.paymentTransfer') + ' '
                                : i18n.t('run.label.paymentCash') + ' '}
                              {skuName}
                            </span>
                            <span className="font-mono text-old-body tabular-nums">
                              {formatMoney(l.lineTotal)}
                            </span>
                          </div>
                          <div className="flex items-baseline gap-2 text-old-label text-[var(--c-fg-muted)]">
                            <span>{store}</span>
                            <span>· {supplier}</span>
                            <span className="ml-auto font-mono tabular-nums">
                              {l.qty} × {formatMoney(l.unitPrice)}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : view === 'bySupplier' ? (
        <ul className="flex flex-col gap-1" role="list">
          {supplierGroups.map((g) => {
            const key = g.key;
            const isOpen = expanded === key;
            const name =
              key === '__expense'
                ? `🧾 ${i18n.t('finance.label.expenses')}`
                : g.supplierId
                  ? (supplierById.get(g.supplierId) ?? g.supplierId.slice(0, 8))
                  : `— ${i18n.t('finance.label.noSupplier')}`;
            const mixed = g.cash > 0 && g.transfer > 0;
            return (
              <li
                key={key}
                className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : key)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left active:opacity-80"
                >
                  <span className="truncate text-old-body font-semibold">{name}</span>
                  <span className="font-mono text-old-body tabular-nums">
                    {formatMoney(g.cash + g.transfer)}
                  </span>
                </button>
                {mixed ? (
                  <div className="flex items-baseline gap-3 px-3 pb-1.5 text-old-label text-[var(--c-fg-muted)]">
                    <span>
                      {i18n.t('run.label.paymentCash')} {formatMoney(g.cash)}
                    </span>
                    <span>
                      {i18n.t('run.label.paymentTransfer')} {formatMoney(g.transfer)}
                    </span>
                  </div>
                ) : null}
                {isOpen ? (
                  <ul className="flex flex-col border-t border-[var(--c-divider)]" role="list">
                    {g.lines.map((l, i) => {
                      const skuName = lineName(l);
                      return (
                        <li
                          key={lineKey(l, i)}
                          className="flex items-baseline justify-between gap-2 border-b border-[var(--c-divider)] px-3 py-1.5 text-old-label last:border-b-0"
                        >
                          <span className="truncate">
                            {l.runDate} ·{' '}
                            {l.paymentMethod === 'transfer'
                              ? i18n.t('run.label.paymentTransfer')
                              : i18n.t('run.label.paymentCash')}{' '}
                            {skuName}
                          </span>
                          <span className="font-mono tabular-nums">{formatMoney(l.lineTotal)}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="flex flex-col gap-1" role="list">
          {storeGroups.map((g) => {
            const isOpen = expanded === g.storeId;
            const name = storeById.get(g.storeId) ?? g.storeId.slice(0, 8);
            const mixed = g.cash > 0 && g.transfer > 0;
            return (
              <li
                key={g.storeId}
                className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : g.storeId)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left active:opacity-80"
                >
                  <span className="truncate text-old-body font-semibold">{name}</span>
                  <span className="font-mono text-old-body tabular-nums">
                    {formatMoney(g.cash + g.transfer)}
                  </span>
                </button>
                {mixed ? (
                  <div className="flex items-baseline gap-3 px-3 pb-1.5 text-old-label text-[var(--c-fg-muted)]">
                    <span>
                      {i18n.t('run.label.paymentCash')} {formatMoney(g.cash)}
                    </span>
                    <span>
                      {i18n.t('run.label.paymentTransfer')} {formatMoney(g.transfer)}
                    </span>
                  </div>
                ) : null}
                {isOpen ? (
                  <ul className="flex flex-col border-t border-[var(--c-divider)]" role="list">
                    {g.lines.map((l, i) => {
                      const skuName = lineName(l);
                      return (
                        <li
                          key={lineKey(l, i)}
                          className="flex items-baseline justify-between gap-2 border-b border-[var(--c-divider)] px-3 py-1.5 text-old-label last:border-b-0"
                        >
                          <span className="truncate">
                            {l.runDate} ·{' '}
                            {l.paymentMethod === 'transfer'
                              ? i18n.t('run.label.paymentTransfer')
                              : i18n.t('run.label.paymentCash')}{' '}
                            {skuName}
                          </span>
                          <span className="font-mono tabular-nums">{formatMoney(l.lineTotal)}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
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
              ? i18n.t('ops.maint.resetting')
              : datePreview && datePreview.total > 0
                ? i18n.t('ops.purge.deleteRows', { n: datePreview.total })
                : i18n.t('ops.maint.nothingToDelete')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {datePreview ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {datePreview.total === 0
                  ? i18n.t('ops.maint.alreadyClean', { date: datePreview.date })
                  : i18n.t('ops.maint.rowsFromDate', { n: datePreview.total, date: datePreview.date })}
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
            {allCommit.isPending
              ? i18n.t('ops.purge.deleting')
              : i18n.t('ops.purge.deleteRows', { n: allDryRun.data?.total ?? 0 })}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {allDryRun.data ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {i18n.t('ops.purge.rowsWouldBeDeleted', { n: allDryRun.data.total })}
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
