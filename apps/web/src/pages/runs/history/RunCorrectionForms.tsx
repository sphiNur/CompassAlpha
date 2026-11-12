/**
 * The corrections a super-admin (run.amend) may make to a finished run,
 * shown at the end of its history detail.
 *
 * DX-HIS-13 (2026-11-01): the two forms come after the record they
 * correct; they used to sit above the lines, so reading the run meant
 * scrolling past two forms first.
 */
import { useEffect, useState } from 'react';
import { Button, Input, SectionLabel, surfaceClass, useToast } from '@compass/ui';
import { useErrToast } from '../../../hooks/useErrToast';
import { useI18n } from '../../../hooks/useI18n';
import { localDateValue } from '../../../lib/calendarDate';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useNavStore } from '../../../stores/navStore';
import type { HistoryDetailTarget } from './detailTarget';

export function RunCorrectionForms({
  target,
  onClose,
}: {
  target: HistoryDetailTarget;
  /** Closes the detail sheet once a correction is made. */
  onClose: () => void;
}) {
  const i18n = useI18n();
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const orgToday = localDateValue(new Date(), orgTimeZone);
  // 2026-07-06: super-admins (run.amend) may reopen a finished run to
  // correct it. The reopen moves it to `amending`; editing continues on
  // the 采购 (Run) tab, and the correction is closed with "完成修改" there.
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [reopenReason, setReopenReason] = useState('');
  const reopen = trpc.run.reopen.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      // 2026-10-21 audit D-18: run.history lists finished runs only, so
      // the reopened (now amending) run must drop out of it right away.
      void utils.run.history.invalidate();
      void utils.run.historyDetail.invalidate();
      toast.success(i18n.t('run.amend.reopenedGoing'));
      setReopenReason('');
      onClose();
      // R2-INT-4 (2026-10-31): take the corrector to the purchase tab,
      // which opens on the run being corrected (pickActiveRun prefers an
      // amending run for run.amend holders); they used to have to go there.
      useNavStore.getState().setTab('run');
    },
    onError: errToast('common.errors.actionFailed'),
  });

  /**
   * Purchase-date correction (2026-07-30).
   *
   * `runDate` is set once, when the run is CREATED, and nothing ever
   * changed it — so a run opened on the 23rd and closed on the 30th books
   * its whole spend under the 23rd. History groups and totals by this
   * field, so a wrong value quietly misattributes a day's (and a month's)
   * spend. This is the correction surface: past runs are exactly where
   * you notice the date is wrong.
   *
   * Unlike the reopen path below, this does NOT move the run to
   * `amending` — it touches no money, and refinalizing would rewrite the
   * frozen totals as a side effect of a pure calendar fix.
   */
  const [dateDraft, setDateDraft] = useState(target.runDate);
  useEffect(() => {
    setDateDraft(target.runDate);
  }, [target.runDate, target.runId]);
  const changeDate = trpc.run.changeDate.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.history.invalidate();
      void utils.run.get.invalidate();
      void utils.run.historyDetail.invalidate();
      toast.success(i18n.t('run.date.changed'));
      onClose();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <>
      <SectionLabel padded={false} as="h3" className="-mb-2">
        {i18n.t('run.history.correctionsHeading')}
      </SectionLabel>
      {/* 2026-07-30: purchase-date correction. Separate from the reopen
          block below on purpose — changing when a run is booked is not an
          edit to what was bought, so it neither needs nor triggers the
          amend cycle. */}
      <div className={`flex flex-col gap-2 px-4 py-3 ${surfaceClass}`}>
        <SectionLabel padded={false}>{i18n.t('run.date.label')}</SectionLabel>
        <p className="text-old-label text-[var(--c-fg-muted)]">{i18n.t('run.date.hint')}</p>
        {/* HIS-7 (2026-10-31): the server refuses a date after the org's
            today; the picker stops there and the button waits. */}
        <Input
          type="date"
          value={dateDraft}
          max={orgToday}
          invalid={dateDraft > orgToday}
          onChange={(e) => setDateDraft(e.target.value)}
          aria-label={i18n.t('run.date.label')}
        />
        <Button
          variant="pearl"
          loading={changeDate.isPending}
          disabled={!dateDraft || dateDraft === target.runDate || dateDraft > orgToday}
          onClick={() => changeDate.mutate({ runId: target.runId, runDate: dateDraft })}
        >
          {i18n.t('run.date.change')}
        </Button>
      </div>

      {/* 2026-07-06: super-admin correction entry. Reopens the finished
          run to `amending`; editing continues on the Run tab, closed there
          with "完成修改". Requires a reason (audit). */}
      <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-warn-bg)] px-4 py-3">
        <SectionLabel padded={false}>{i18n.t('run.amend.entryLabel')}</SectionLabel>
        <Input
          value={reopenReason}
          onChange={(e) => setReopenReason(e.target.value)}
          placeholder={i18n.t('run.amend.reasonPlaceholder')}
          maxLength={500}
        />
        <Button
          variant="pearl"
          loading={reopen.isPending}
          disabled={reopenReason.trim().length === 0}
          onClick={() => reopen.mutate({ runId: target.runId, reason: reopenReason.trim() })}
        >
          {i18n.t('run.amend.reopenButton')}
        </Button>
      </div>
    </>
  );
}
