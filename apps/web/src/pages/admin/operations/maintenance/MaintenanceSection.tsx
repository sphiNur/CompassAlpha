/**
 * Admin → Operations → Maintenance: deleting single test orders and runs,
 * resetting a day and wiping the workspace. Review ADM2-10 (2026-11-11):
 * its own file; its parts sat at both ends of a 2,260-line file.
 */
import { useEffect, useState } from 'react';
import { Banner, Button, Card, Field, Input, Sheet, useToast } from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { useAuthStore } from '../../../../stores/authStore';
import { useErrToast } from '../../../../lib/errToast';
import { useDateFormat, useI18n } from '../../../../hooks/useI18n';
import { maintenanceToday } from '../financeDates';
import { resetConfirmMatches, wipeConfirmMatches } from '../purgeCounts';
import { PurgePreview } from './PurgePreview';
import { TargetedPurgeBrowser } from './TargetedPurgeBrowser';

export function MaintenanceSection() {
  const session = useAuthStore((s) => s.session);
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const dates = useDateFormat();

  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  // DX-CAT-17: the wipe is confirmed with the name shown on the workspace
  // page, not the slug nobody sees.
  const orgName = session?.member.orgName ?? '';
  const orgTimeZone = session?.member.timezone;
  // R2-CAT-3: the live server refuses the bulk purges; don't offer them.
  // Until the config arrives (or from an older server) they stay shown.
  const appConfig = trpc.system.appConfig.useQuery(undefined, { staleTime: Infinity });
  const bulkPurgeAllowed = appConfig.data?.bulkPurgeAllowed !== false;

  // ---- by-date purge state ----
  const [dateInput, setDateInput] = useState<string>(() =>
    maintenanceToday(new Date(), orgTimeZone),
  );
  const [datePreview, setDatePreview] = useState<{
    date: string;
    total: number;
    byTable: Record<string, number>;
    // DX-CAT-5: absent from an older server's answer.
    scope?: {
      sameDay: { orders: number; runs: number };
      linkedOrders: Array<{ orderDate: string; storeName: string | null; count: number }>;
      linkedRuns: Array<{ runDate: string; runIndex: number }>;
    };
  } | null>(null);
  const [dateConfirmOpen, setDateConfirmOpen] = useState(false);
  const [dateConfirmText, setDateConfirmText] = useState('');
  const dateConfirmed = resetConfirmMatches(dateConfirmText, datePreview?.date ?? '');
  useEffect(() => {
    if (!dateConfirmOpen) setDateConfirmText('');
  }, [dateConfirmOpen]);

  const datePreviewMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      setDatePreview({
        date: data.date,
        total: data.total,
        byTable: data.byTable,
        scope: data.scope,
      });
      setDateConfirmOpen(true);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const dateCommitMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      toast.success(
        i18n.t('admin.toast.dateReset', { date: dates.calendarDay(data.date), n: data.total }),
      );
      setDateConfirmOpen(false);
      setDatePreview(null);
      void utils.invalidate();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  // ---- nuclear-purge state ----
  const [confirmText, setConfirmText] = useState('');
  const [allOpen, setAllOpen] = useState(false);
  const nameMatches = wipeConfirmMatches(confirmText, orgName);
  const allDryRun = trpc.admin.purgeAllTestData.useMutation({
    onError: errToast('common.errors.actionFailed'),
  });
  const allCommit = trpc.admin.purgeAllTestData.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.dataPurged', { n: data.total }));
      setAllOpen(false);
      setConfirmText('');
      void utils.invalidate();
    },
    onError: errToast('common.errors.actionFailed'),
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

      {bulkPurgeAllowed ? (
        <>
          {/* ============ Reset today (still useful when nothing real yet) ============ */}
          <div className="mt-3">
            <Card>
              <div className="flex flex-col gap-3 px-4 py-4">
                <div>
                  <div className="text-old-h2 font-semibold text-[var(--c-fg)]">
                    {i18n.t('ops.maint.resetTodayTitle')}
                  </div>
                  <p className="mt-0.5 text-old-body-sm text-[var(--c-fg-muted)]">
                    {i18n.t('ops.maint.resetTodayBody', {
                      date: dates.calendarDay(maintenanceToday(new Date(), orgTimeZone)),
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="pearl"
                  loading={datePreviewMut.isPending}
                  onClick={() =>
                    datePreviewMut.mutate({
                      date: maintenanceToday(new Date(), orgTimeZone),
                      dryRun: true,
                    })
                  }
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
                  {/* ADM2-33: the kit field. DX-IX-8: named. */}
                  <Input
                    type="date"
                    value={dateInput}
                    onChange={(e) => setDateInput(e.target.value)}
                    aria-label={i18n.t('ops.maint.resetDateTitle')}
                    className="flex-1"
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
        </>
      ) : (
        <div className="mt-3">
          <Banner tone="info" title={i18n.t('ops.maint.bulkDisabledTitle')}>
            {i18n.t('ops.maint.bulkDisabledBody')}
          </Banner>
        </div>
      )}

      {/* ============ Date-purge confirm sheet ============ */}
      <Sheet
        open={dateConfirmOpen}
        onOpenChange={(o) => !o && !dateCommitMut.isPending && setDateConfirmOpen(false)}
        title={i18n.t('ops.maint.resetSheetTitle', {
          date: datePreview ? dates.calendarDay(datePreview.date) : '',
        })}
        description={i18n.t('ops.maint.resetSheetBody')}
        footer={
          <Button
            block
            variant="danger"
            loading={dateCommitMut.isPending}
            disabled={!datePreview || datePreview.total === 0 || !dateConfirmed}
            onClick={() => {
              if (!datePreview || !dateConfirmed) return;
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
            <PurgePreview
              title={
                datePreview.total === 0
                  ? i18n.t('ops.maint.alreadyClean', { date: dates.calendarDay(datePreview.date) })
                  : i18n.t('ops.maint.rowsFromDate', {
                      n: datePreview.total,
                      date: dates.calendarDay(datePreview.date),
                    })
              }
              byTable={datePreview.total > 0 ? datePreview.byTable : undefined}
            />
          ) : null}
          {/* DX-CAT-5 (2026-11-01): what is this day's, and what goes with
              it from other dates because an order and its run are deleted
              together — each with its date. */}
          {datePreview && datePreview.total > 0 && datePreview.scope ? (
            <div className="flex flex-col gap-2 text-old-body-sm text-[var(--c-fg)]">
              <p>
                {i18n.t('ops.maint.scopeSameDay', {
                  date: dates.calendarDay(datePreview.date),
                  orders: i18n.t('run.label.sessionsCount', {
                    n: datePreview.scope.sameDay.orders,
                  }),
                  runs: i18n.t('finance.count.runs', { n: datePreview.scope.sameDay.runs }),
                })}
              </p>
              {datePreview.scope.linkedOrders.length > 0 ||
              datePreview.scope.linkedRuns.length > 0 ? (
                <Banner tone="warn" title={i18n.t('ops.maint.scopeLinkedTitle')}>
                  <ul className="mt-1 flex flex-col gap-0.5" role="list">
                    {datePreview.scope.linkedRuns.map((r) => (
                      <li key={`run-${r.runDate}-${r.runIndex}`}>
                        {i18n.t('ops.purge.runLabel', {
                          date: dates.calendarDay(r.runDate),
                          n: r.runIndex + 1,
                        })}
                      </li>
                    ))}
                    {datePreview.scope.linkedOrders.map((o) => (
                      <li key={`order-${o.orderDate}-${o.storeName ?? ''}`}>
                        {i18n.t('ops.maint.scopeLinkedOrders', {
                          date: dates.calendarDay(o.orderDate),
                          store: o.storeName ?? i18n.t('ops.purge.unknownStore'),
                          orders: i18n.t('run.label.sessionsCount', { n: o.count }),
                        })}
                      </li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
            </div>
          ) : null}
          {/* CMP-OPS-5: typed confirmation, like the full wipe. */}
          {datePreview && datePreview.total > 0 ? (
            <Field
              label={i18n.t('ops.maint.confirmResetLabel')}
              // ADM2-21: the one date left as 2026-11-11 — it is typed back.
              hint={i18n.t('ops.maint.confirmResetBody', { date: datePreview.date })}
            >
              <Input
                value={dateConfirmText}
                onChange={(e) => setDateConfirmText(e.target.value)}
                placeholder={datePreview.date}
                // DX-CAT-4: no number pad — it has no "-" on an iPhone;
                // resetConfirmMatches compares the digits only anyway.
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
          ) : null}
        </div>
      </Sheet>

      {/* ============ Nuclear-purge confirm sheet ============ */}
      <Sheet
        open={allOpen}
        onOpenChange={(o) => !o && !allCommit.isPending && setAllOpen(false)}
        title={i18n.t('ops.maint.confirmPurgeTitle')}
        description={i18n.t('ops.maint.confirmPurgeByName', { name: orgName })}
        footer={
          <Button
            block
            variant="danger"
            loading={allCommit.isPending}
            // DX-CAT-17: nothing to delete, nothing to confirm.
            disabled={!nameMatches || !allDryRun.data || allDryRun.data.total === 0}
            onClick={() => {
              if (!nameMatches) return;
              allCommit.mutate({ dryRun: false, confirmText: confirmText.trim() });
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
            <PurgePreview
              title={i18n.t('ops.purge.rowsWouldBeDeleted', { n: allDryRun.data.total })}
              byTable={allDryRun.data.byTable}
            >
              {allDryRun.data.total === 0 ? (
                <p className="mt-2 text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('ops.maint.nothingToPurge')}
                </p>
              ) : null}
            </PurgePreview>
          ) : null}

          <Field label={i18n.t('ops.maint.confirmPurgeNameLabel')}>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={i18n.t('ops.maint.confirmPurgeNamePlaceholder')}
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
