/**
 * 待核对 (2026-11-06): the store's flagged punches nobody has looked at
 * yet: a face that does not match (and whom it looks like), a failed
 * liveness check, a colleague's phone, a new phone. The manager looks at
 * the photos, then lets the punch stand or voids it with a reason.
 *
 * Face enrollments (2026-11-06) wait here too: the manager compares the
 * photos with the person they know and approves, or sends them back
 * with a reason. Nobody approves their own.
 */
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  rowGroupClass,
  useToast,
} from '@compass/ui';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { haptic } from '../../lib/telegram';
import { useErrToast } from '../../hooks/useErrToast';
import { trpc } from '../../lib/trpc';
import { FACE_TONE, LIVE_TONE } from '../../lib/attendanceFormat';
import { EnrollPhotos, PunchPhotoStrip } from './AttendancePhotos';

export function AttendanceReview({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const queue = trpc.attendance.reviewQueue.useQuery({ storeId });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => {
    void utils.attendance.reviewQueue.invalidate();
    void utils.attendance.sheet.invalidate();
  };
  const review = trpc.attendance.reviewPunch.useMutation({
    onSuccess: () => {
      haptic('success');
      toast.success(i18n.t('attendance.toast.punchReviewed'));
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const voidPunch = trpc.attendance.voidPunch.useMutation({
    onSuccess: () => {
      haptic('success');
      toast.success(i18n.t('attendance.toast.punchVoided'));
      setVoiding(null);
      setReason('');
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });

  return (
    <div className="flex flex-col gap-3 px-4">
      <DataState query={queue}>
        {(data) => (
          <>
            {data.overtimePending > 0 ? (
              <Banner tone="info" title={i18n.t('attendance.review.overtimeTitle')}>
                {i18n.t('attendance.review.overtimeBody', { count: data.overtimePending })}
              </Banner>
            ) : null}
            {data.enrollments.length > 0 ? (
              <section className="flex flex-col gap-2">
                <SectionLabel as="h2" padded={false}>
                  {i18n.t('attendance.review.enrollTitle')}
                </SectionLabel>
                {/* Review ATT-07 (UI-6): one card of rows, not a card each. */}
                <ul className={rowGroupClass} role="list">
                  {data.enrollments.map((e) => (
                    <EnrollItem key={e.id} storeId={storeId} enrollment={e} />
                  ))}
                </ul>
              </section>
            ) : null}
            {data.punches.length === 0 && data.enrollments.length === 0 ? (
              <EmptyState
                title={i18n.t('attendance.review.emptyTitle')}
                description={i18n.t('attendance.review.emptyBody')}
              />
            ) : data.punches.length === 0 ? null : (
              <ul
                className={rowGroupClass}
                role="list"
                aria-label={i18n.t('attendance.view.review')}
              >
                {data.punches.map((p) => (
                  <li key={p.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-old-body font-semibold text-[var(--c-fg)]">
                        {p.name}
                      </span>
                      <span className="tabular-nums text-old-label text-[var(--c-fg-muted)]">
                        {dates.calendarDay(p.date)} {p.time} ·{' '}
                        {i18n.t(p.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out')}
                      </span>
                    </div>
                    <span className="flex flex-wrap items-center gap-1">
                      {p.face === 'mismatch' ? (
                        <Badge tone={FACE_TONE.mismatch}>
                          {i18n.t('attendance.face.mismatch')}
                        </Badge>
                      ) : null}
                      {p.faceLikeName ? (
                        <Badge tone="danger">
                          {i18n.t('attendance.face.like', { name: p.faceLikeName })}
                        </Badge>
                      ) : null}
                      {p.liveness === 'fail' ? (
                        <Badge tone={LIVE_TONE.fail}>{i18n.t('attendance.live.badge.fail')}</Badge>
                      ) : null}
                      {p.newDevice ? (
                        <Badge tone="warn">{i18n.t('attendance.device.newBadge')}</Badge>
                      ) : null}
                    </span>
                    {p.viaName ? (
                      <span className="text-old-label text-[var(--c-fg-muted)]">
                        {i18n.t('attendance.borrow.via', { name: p.viaName })}
                      </span>
                    ) : null}
                    <PunchPhotoStrip storeId={storeId} punchId={p.id} />
                    {p.own ? (
                      <span className="text-old-label text-[var(--c-fg-muted)]">
                        {i18n.t('attendance.sheet.ownHint')}
                      </span>
                    ) : voiding === p.id ? (
                      <div className="flex flex-col gap-2">
                        <Field label={i18n.t('attendance.void.reasonLabel', { time: p.time })}>
                          <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            maxLength={300}
                            placeholder={i18n.t('attendance.void.reasonPlaceholder')}
                          />
                        </Field>
                        <div className="flex gap-2">
                          <Button variant="secondary" onClick={() => setVoiding(null)}>
                            {i18n.t('common.cancel')}
                          </Button>
                          <Button
                            variant="danger"
                            disabled={reason.trim().length === 0}
                            loading={voidPunch.isPending}
                            onClick={() =>
                              voidPunch.mutate({ storeId, punchId: p.id, reason: reason.trim() })
                            }
                          >
                            {i18n.t('attendance.void.confirm')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          loading={review.isPending && review.variables?.punchId === p.id}
                          onClick={() => review.mutate({ storeId, punchId: p.id })}
                        >
                          {i18n.t('attendance.review.ok')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setReason('');
                            setVoiding(p.id);
                          }}
                        >
                          {i18n.t('attendance.void.action')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DataState>
    </div>
  );
}

/** One waiting face enrollment: its photos (and the one in use), approve or send back. */
function EnrollItem({
  storeId,
  enrollment,
}: {
  storeId: string;
  enrollment: {
    id: string;
    memberId: string;
    name: string;
    own: boolean;
    date: string;
    time: string;
  };
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const photos = trpc.attendance.faceEnrollment.useQuery({
    storeId,
    memberId: enrollment.memberId,
  });
  const decide = trpc.attendance.faceEnrollDecide.useMutation({
    onSuccess: (_r, input) => {
      haptic('success');
      toast.success(
        i18n.t(
          input.approve ? 'attendance.toast.enrollApproved' : 'attendance.toast.enrollRejected',
        ),
      );
      void utils.attendance.reviewQueue.invalidate();
      void utils.attendance.sheet.invalidate();
      void utils.attendance.faceEnrollment.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const waiting = photos.data?.find((x) => x.id === enrollment.id);
  const inUse = photos.data?.find((x) => x.status === 'approved');
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-old-body font-semibold text-[var(--c-fg)]">{enrollment.name}</span>
        <span className="tabular-nums text-old-label text-[var(--c-fg-muted)]">
          {dates.calendarDay(enrollment.date)} {enrollment.time}
        </span>
      </div>
      {waiting ? <EnrollPhotos photos={waiting.photos} name={enrollment.name} /> : null}
      {inUse ? (
        <>
          <span className="text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('attendance.review.enrollInUse')}
          </span>
          <EnrollPhotos photos={inUse.photos} name={enrollment.name} />
        </>
      ) : null}
      {enrollment.own ? (
        <span className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('attendance.review.enrollOwn')}
        </span>
      ) : rejecting ? (
        <div className="flex flex-col gap-2">
          <Field label={i18n.t('attendance.review.enrollReasonLabel')}>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder={i18n.t('attendance.review.enrollReasonPlaceholder')}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              {i18n.t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={note.trim().length === 0}
              loading={decide.isPending}
              onClick={() =>
                decide.mutate({
                  storeId,
                  enrollmentId: enrollment.id,
                  approve: false,
                  note: note.trim(),
                })
              }
            >
              {i18n.t('attendance.review.enrollReject')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            loading={decide.isPending}
            disabled={!waiting}
            onClick={() => decide.mutate({ storeId, enrollmentId: enrollment.id, approve: true })}
          >
            {i18n.t('attendance.review.enrollApprove')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNote('');
              setRejecting(true);
            }}
          >
            {i18n.t('attendance.review.enrollReject')}
          </Button>
        </div>
      )}
    </li>
  );
}
