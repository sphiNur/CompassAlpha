/**
 * 待核对 (2026-11-06): the store's flagged punches nobody has looked at
 * yet: a face that does not match (and whom it looks like), a failed
 * liveness check, a colleague's phone, a new phone. The manager looks at
 * the photos, then lets the punch stand or voids it with a reason.
 */
import { useState } from 'react';
import { Badge, Banner, Button, DataState, EmptyState, Field, Input } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { useErrToast } from '../../lib/errToast';
import { trpc } from '../../lib/trpc';
import { FACE_TONE, LIVE_TONE, PunchPhotoStrip } from './AttendanceManage';

export function AttendanceReview({ storeId }: { storeId: string }) {
  const i18n = useI18n();
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
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const voidPunch = trpc.attendance.voidPunch.useMutation({
    onSuccess: () => {
      haptic('success');
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
            {data.punches.length === 0 ? (
              <EmptyState
                title={i18n.t('attendance.review.emptyTitle')}
                description={i18n.t('attendance.review.emptyBody')}
              />
            ) : (
              <ul className="flex flex-col gap-2" aria-label={i18n.t('attendance.view.review')}>
                {data.punches.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface)] p-3 ring-hairline"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-old-body font-semibold text-[var(--c-fg)]">
                        {p.name}
                      </span>
                      <span className="tabular-nums text-old-label text-[var(--c-fg-muted)]">
                        {p.date} {p.time} ·{' '}
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
                    <PunchPhotoStrip storeId={storeId} punchId={p.id} canSetFace={false} />
                    {voiding === p.id ? (
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
