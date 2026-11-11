/**
 * Maintenance: deleting one order or one run of a day, each after a
 * dry-run preview. Review ADM2-10 (2026-11-11): its own file; it shows
 * what would go with PurgePreview, as the day and workspace resets do.
 */
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  Input,
  LoadingState,
  Segmented,
  Sheet,
  rowListClass,
  useToast,
} from '@compass/ui';
import { PAGE_SIZE } from '../../../../config/timings';
import { trpc } from '../../../../lib/trpc';
import { orderStatusLabel, runStatusLabel } from '../../../../lib/statusLabels';
import { useAuthStore } from '../../../../stores/authStore';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useDateFormat, useI18n } from '../../../../hooks/useI18n';
import { maintenanceToday } from '../financeDates';
import { PurgePreview } from './PurgePreview';

/**
 * Surgical purge browser. Two stacked lists (Orders / Runs) for the
 * chosen date; each row has its own Delete button that opens a
 * dry-run preview sheet before committing.
 */
export function TargetedPurgeBrowser() {
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [date, setDate] = useState(() => maintenanceToday(new Date(), orgTimeZone));
  const [tab, setTab] = useState<'orders' | 'runs'>('orders');
  const sessionsQuery = trpc.admin.sessionList.useQuery({ date, limit: PAGE_SIZE.list });
  const runsQuery = trpc.admin.runList.useQuery({ date, limit: PAGE_SIZE.list });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  // Review ADM2-21 (2026-11-11): dates in the interface language, as on the
  // rest of this screen, not the raw 2026-11-11.
  const dates = useDateFormat();

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
      errToast('common.errors.actionFailed')(err);
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
    onError: errToast('common.errors.actionFailed'),
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
      errToast('common.errors.actionFailed')(err);
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
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Review ADM2-13 (2026-11-11): wraps. At 320px the tabs left the date
          field «11/11» in Uzbek; 9rem holds the whole date and its icon. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Review ADM2-33 (2026-11-11): the kit field, not a copy of its
            classes. DX-IX-8 (2026-11-01): named. */}
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={i18n.t('ops.purge.dateLabel')}
          className="min-w-[9rem] flex-1"
        />
        {/* DX-VIS-7 (2026-11-01): was two hand-rolled pills whose state
            was colour only; Segmented says which is selected. */}
        <Segmented
          value={tab}
          onChange={setTab}
          equalWidth={false}
          ariaLabel={i18n.t('ops.purge.listLabel')}
          options={[
            { value: 'orders', label: i18n.t('ops.purge.tabOrders') },
            { value: 'runs', label: i18n.t('ops.purge.tabRuns') },
          ]}
        />
      </div>

      {tab === 'orders' ? (
        <DataState
          query={sessionsQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <EmptyState
              title={i18n.t('ops.purge.noSessionsTitle')}
              description={i18n.t('ops.purge.noSessionsBody', { date: dates.calendarDay(date) })}
            />
          }
        >
          {(rows) => (
            // Review ADM2-12 (2026-11-11): rows divided by hairlines (UI-6),
            // with no surface of their own: this list sits inside the
            // maintenance card (UI-13), so it is not a card either.
            <ul className={rowListClass} role="list">
              {rows.map((sess) => {
                const attribLabel =
                  sess.attribDisplayName ?? i18n.t('run.sessions.unknownSubmitter');
                // DX-CAT-3 (2026-11-01): the server says whether this order
                // can be deleted here; a row that can't says why, and has
                // no red Delete that only refuses after a tap.
                const blockText = sessionBlockText(i18n, sess.deleteBlock, attribLabel);
                const label = `${sess.storeName ?? i18n.t('common.unknownStore')} · ${attribLabel}`;
                return (
                  <li key={sess.sessionId} className="flex items-center gap-3 py-2.5">
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
                          status: orderStatusLabel(i18n, sess.status),
                          items: i18n.t('run.label.itemsCount', { n: sess.itemCount }),
                          date: dates.calendarDay(sess.orderDate),
                        })}
                      </div>
                    </div>
                    {blockText ? (
                      <span className="max-w-[45%] text-right text-old-label text-[var(--c-fg-muted)]">
                        {blockText}
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
              description={i18n.t('ops.purge.noRunsBody', { date: dates.calendarDay(date) })}
            />
          }
        >
          {(rows) => (
            <ul className={rowListClass} role="list">
              {rows.map((r) => {
                const label = i18n.t('ops.purge.runLabel', {
                  date: dates.calendarDay(r.runDate),
                  n: r.runIndex + 1,
                });
                const blockText = runBlockText(i18n, r.deleteBlock);
                return (
                  <li key={r.runId} className="flex items-center gap-3 py-2.5">
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
                          status: runStatusLabel(i18n, r.status),
                          sessions: i18n.t('run.label.sessionsCount', {
                            n: r.sessionCount,
                          }),
                        })}
                        {r.purchaserDisplayName
                          ? ` ${i18n.t('ops.history.decidedBy', { name: r.purchaserDisplayName })}`
                          : ''}
                      </div>
                    </div>
                    {blockText ? (
                      <span className="max-w-[45%] text-right text-old-label text-[var(--c-fg-muted)]">
                        {blockText}
                      </span>
                    ) : (
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
                    )}
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
            <LoadingState variant="inline" label={i18n.t('admin.label.counting')} />
          ) : sessionTarget?.preview ? (
            <PurgePreview
              title={i18n.t('ops.purge.rowsWouldBeDeleted', { n: sessionTarget.preview.total })}
              byTable={sessionTarget.preview.byTable}
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
            <LoadingState variant="inline" label={i18n.t('admin.label.counting')} />
          ) : runTarget?.preview ? (
            <>
              <Banner tone="warn" title={i18n.t('ops.purge.cascadeTitle')}>
                {i18n.t('ops.purge.cascadeBody', {
                  n: runTarget.preview.sessionIds.length,
                })}
              </Banner>
              <PurgePreview
                title={i18n.t('ops.purge.rowsWouldBeDeleted', { n: runTarget.preview.total })}
                byTable={runTarget.preview.byTable}
              />
            </>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}

type I18n = ReturnType<typeof useI18n>;

/** DX-CAT-3: why an order can't be deleted here, or null when it can. */
function sessionBlockText(
  i18n: I18n,
  block: 'notSuperAdmin' | 'inRun' | 'othersOrder' | 'othersLines' | 'actedOnByOthers' | null,
  author: string,
): string | null {
  switch (block) {
    case 'notSuperAdmin':
      return i18n.t('ops.purge.block.notSuperAdmin');
    case 'inRun':
      return i18n.t('ops.purge.block.inRun');
    case 'othersOrder':
      return i18n.t('ops.purge.block.othersOrder', { name: author });
    case 'othersLines':
      return i18n.t('ops.purge.block.othersLines');
    case 'actedOnByOthers':
      return i18n.t('ops.purge.block.orderActedOn');
    default:
      return null;
  }
}

/** DX-CAT-3: why a run can't be deleted here, or null when it can. */
function runBlockText(
  i18n: I18n,
  block: 'notSuperAdmin' | 'foreignSessions' | 'actedOnByOthers' | null,
): string | null {
  switch (block) {
    case 'notSuperAdmin':
      return i18n.t('ops.purge.block.notSuperAdmin');
    case 'foreignSessions':
      return i18n.t('ops.purge.block.runForeign');
    case 'actedOnByOthers':
      return i18n.t('ops.purge.block.runActedOn');
    default:
      return null;
  }
}
