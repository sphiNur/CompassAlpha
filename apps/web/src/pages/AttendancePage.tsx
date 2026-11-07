/**
 * AttendancePage — clock in / out (2026-11-05).
 *
 * The tab shows only to members switched on for clocking
 * (`attendance.clock`). Managers plan and review attendance under
 * Admin → Attendance (pages/attendance/AttendanceAdmin.tsx), so the
 * bottom bar does not grow for them. A punch is sent live with
 * the phone's id and, when the store asks for it, its location; the
 * server checks both and records its own time.
 * Nothing is queued offline: a clock-in must happen where and when it
 * says it did.
 *
 * Checks (2026-11-06): the person agrees in the app before their face is
 * used; the head turns come only when the server asks (a risk signal or
 * the 1-in-3 spot check), and the server may ask for them after a plain
 * face photo too. A colleague clocking on this phone is found by their
 * face, not picked from a list.
 *
 * Face only (owner decisions 2026-11-06): the person first agrees, then
 * enrolls their face (a Face ID-style ring) and waits for a manager's
 * approval; only then is the clock button there. Every punch is checked
 * against that face, and the photos are taken by the face tracker alone.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ConfirmSheet,
  DataState,
  EmptyState,
  PageHeader,
  Sheet,
  Textarea,
} from '@compass/ui';
import { ATTENDANCE_FACE_CONSENT_VERSION } from '@compass/contracts/limits';
import { haptic } from '../hooks/useTelegram';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { useStoreContext } from '../components/StoreSwitcher';
import { useDateFormat, useI18n } from '../hooks/useI18n';
import { useOnline } from '../hooks/useOnline';
import { attendanceDeviceId, devicePlatform } from '../lib/attendanceDevice';
import { currentLocation, isLocationError, openLocationSettings } from '../lib/attendanceLocation';
import { errorVars, serverErrorKey } from '../lib/errorText';
import { useErrToast } from '../lib/errToast';
import { minutesText } from '../lib/attendanceFormat';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { loadFaceTracker } from '../lib/faceTracker';
import { FaceConsentSheet } from './attendance/FaceConsentSheet';
import { FaceEnrollSheet } from './attendance/FaceEnrollSheet';
import { PunchCamera, type PunchPhotos, type Turn } from './attendance/PunchCamera';

type Fix = { lat: number; lng: number; accuracy: number };

export function AttendancePage() {
  const i18n = useI18n();
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
  const storeId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const storeName = useAuthStore((s) =>
    storeId ? (s.session?.stores.find((st) => st.id === storeId)?.name ?? null) : null,
  );

  if (!storeId) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
        {noStoreYet ? (
          <NoStoreYet />
        ) : storeCtx.kind === 'none' ? (
          <EmptyState
            title={i18n.t('auth.noStore.title')}
            description={i18n.t('auth.noStore.body')}
          />
        ) : (
          <EmptyState
            title={i18n.t('storeSwitcher.pickPrompt.title')}
            description={i18n.t('storeSwitcher.pickPrompt.body')}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title={i18n.t('attendance.page.title')} subtitle={storeName ?? undefined} />
      <ClockPanel key={storeId} storeId={storeId} />
    </div>
  );
}

function ClockPanel({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const online = useOnline();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationProblem, setLocationProblem] = useState<
    'denied' | 'unavailable' | 'timeout' | null
  >(null);
  const [done, setDone] = useState<{
    kind: 'in' | 'out';
    time: string;
    forName: string | null;
    flagged: boolean;
  } | null>(null);

  useEffect(() => {
    void attendanceDeviceId().then(setDeviceId);
  }, []);

  const me = trpc.attendance.me.useQuery(
    { deviceId: deviceId ?? undefined },
    { enabled: deviceId !== null, refetchInterval: 60_000 },
  );
  // One punch attempt: where, for whom, and the liveness challenge.
  type Attempt = {
    location: Fix | null;
    /** A colleague clocks on this phone; their face says who. */
    identify: boolean;
    challenge: { token: string; steps: Turn[] } | null;
  };
  type PunchVars = Parameters<typeof punch.mutate>[0];
  // A clock-out well past the shift asks why (phase 2): the server refuses
  // it without a reason, and the same punch is sent again with one.
  const [overtimeAsk, setOvertimeAsk] = useState<{ minutes: number; vars: PunchVars } | null>(null);
  // The store asks for a face and a surroundings photo with each punch.
  const [camera, setCamera] = useState<Attempt | null>(null);
  const [overtimeReason, setOvertimeReason] = useState('');
  // A refused face (no turns passed, or not this person's face): try again.
  const [faceRefused, setFaceRefused] = useState<
    | 'attendance.errors.livenessFailed'
    | 'attendance.errors.faceMismatch'
    | 'attendance.errors.faceNotFound'
    | 'attendance.errors.notRecognized'
    | null
  >(null);
  const [preparing, setPreparing] = useState(false);
  // The face-check consent, asked before enrolling or the first face punch.
  const [consentFor, setConsentFor] = useState<{ identify: boolean } | 'enroll' | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const lastAttempt = useRef<Attempt | null>(null);
  const consentGive = trpc.attendance.faceConsentGive.useMutation({
    onSuccess: () => void utils.attendance.me.invalidate(),
  });
  const consentWithdraw = trpc.attendance.faceConsentWithdraw.useMutation({
    onSuccess: () => {
      setWithdrawOpen(false);
      void utils.attendance.me.invalidate();
    },
    onError: errToast('attendance.errors.punchFailed'),
  });
  const challenge = trpc.attendance.livenessChallenge.useMutation();
  const punch = trpc.attendance.punch.useMutation({
    onSuccess: (data) => {
      haptic('success');
      setCamera(null);
      setOvertimeAsk(null);
      setOvertimeReason('');
      setFaceRefused(null);
      setDone({
        kind: data.kind,
        time: data.time,
        forName: data.forName,
        flagged: data.newDevice,
      });
      void utils.attendance.me.invalidate();
    },
    onError: (err, vars) => {
      setCamera(null);
      const key = serverErrorKey(err);
      // The server wants the head turns this time: the same punch again
      // with them (a fresh challenge that asks for the turns).
      if (key === 'attendance.errors.livenessNeeded' && lastAttempt.current) {
        haptic('warning');
        void retryWithTurns(lastAttempt.current);
        return;
      }
      if (key === 'attendance.errors.consentRequired') {
        setConsentFor('enroll');
        return;
      }
      if (key === 'attendance.errors.faceNotEnrolled') {
        void utils.attendance.me.invalidate();
        setEnrolling(true);
        return;
      }
      if (key === 'attendance.errors.overtimeReasonRequired') {
        haptic('warning');
        setOvertimeAsk({ minutes: Number(errorVars(err).minutes ?? 0), vars });
        return;
      }
      if (
        key === 'attendance.errors.livenessFailed' ||
        key === 'attendance.errors.faceMismatch' ||
        key === 'attendance.errors.faceNotFound' ||
        key === 'attendance.errors.notRecognized'
      ) {
        haptic('error');
        setFaceRefused(key);
        return;
      }
      errToast('attendance.errors.punchFailed')(err);
    },
  });

  const store = me.data?.stores.find((x) => x.storeId === storeId) ?? null;
  // Fetch the face tracker while the page is open, not when the camera
  // is: it is a few MB the first time.
  useEffect(() => {
    void loadFaceTracker();
  }, []);
  const face = me.data?.face ?? null;
  const enrolled = face?.status === 'approved';
  // The enrollment ring's own tracker, while the person still has to enroll.
  const mustEnroll = me.data !== undefined && !enrolled && face?.status !== 'pending';
  useEffect(() => {
    if (mustEnroll) void loadFaceTracker('landmarker');
  }, [mustEnroll]);

  /** Agree first, then the ring. */
  const startEnroll = (consented = false) => {
    if (!consented && !me.data?.faceConsent) {
      setConsentFor('enroll');
      return;
    }
    setEnrolling(true);
  };

  const begin = async (identify: boolean) => {
    if (!store || !deviceId) return;
    // The phone's own person agrees and enrolls first; a colleague did so
    // on their own phone (the server checks).
    if (!identify && (!me.data?.faceConsent || !enrolled)) {
      startEnroll();
      return;
    }
    setLocationProblem(null);
    setDone(null);
    let location: Fix | null = null;
    if (store.rules.requireGeo) {
      setLocating(true);
      try {
        location = await currentLocation();
      } catch (e) {
        setLocating(false);
        haptic('error');
        setLocationProblem(isLocationError(e) ? e.reason : 'unavailable');
        return;
      }
      setLocating(false);
    }
    setFaceRefused(null);
    setPreparing(true);
    try {
      const c = await challenge.mutateAsync({
        storeId,
        identify: identify || undefined,
        deviceId,
        location: location ?? undefined,
      });
      setCamera({ location, identify, challenge: { token: c.token, steps: c.steps } });
    } catch (err) {
      errToast('attendance.errors.punchFailed')(err);
    } finally {
      setPreparing(false);
    }
  };

  /** The server asked for the turns after all: a challenge that has them. */
  const retryWithTurns = async (attempt: Attempt) => {
    setPreparing(true);
    try {
      const c = await challenge.mutateAsync({
        storeId,
        identify: attempt.identify || undefined,
        deviceId: deviceId ?? undefined,
        location: attempt.location ?? undefined,
        force: true,
      });
      setCamera({ ...attempt, challenge: { token: c.token, steps: c.steps } });
    } catch (err) {
      errToast('attendance.errors.punchFailed')(err);
    } finally {
      setPreparing(false);
    }
  };

  const send = (attempt: Attempt, photos: PunchPhotos | undefined) => {
    if (!store || !deviceId) return;
    lastAttempt.current = attempt;
    punch.mutate({
      storeId,
      kind: attempt.identify ? undefined : store.nextKind,
      deviceId,
      platform: devicePlatform(),
      location: attempt.location,
      photos: photos ? { face: photos.face, scene: photos.scene } : undefined,
      liveness: attempt.challenge
        ? { token: attempt.challenge.token, left: photos?.left, right: photos?.right }
        : undefined,
      identify: attempt.identify || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-3 px-4">
      <DataState query={me}>
        {() =>
          !store ? (
            <EmptyState
              title={i18n.t('attendance.notEnabled.title')}
              description={i18n.t('attendance.notEnabled.body')}
            />
          ) : (
            <>
              <section className="rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 ring-hairline">
                <p className="text-old-label text-[var(--c-fg-muted)]">
                  {dates.weekdayLong(store.today)}
                </p>
                <TodayShift shifts={store.shifts} today={store.today} />
                {store.punches.length > 0 ? (
                  <ul
                    className="mt-3 flex flex-col gap-1"
                    aria-label={i18n.t('attendance.clock.punches')}
                  >
                    {store.punches.map((p) => (
                      <li key={p.id} className="flex items-center justify-between text-old-body">
                        <span className="text-[var(--c-fg-muted)]">
                          {i18n.t(p.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out')}
                          {p.source === 'manual' ? ` · ${i18n.t('attendance.source.manual')}` : ''}
                        </span>
                        <span className="tabular-nums font-semibold text-[var(--c-fg)]">
                          {p.time}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              {me.data?.device.bound &&
              me.data.device.matches === false &&
              store.rules.requireDevice ? (
                <Banner tone="warn" title={i18n.t('attendance.clock.otherDeviceTitle')}>
                  {i18n.t('attendance.clock.otherDeviceBody')}
                </Banner>
              ) : null}
              {!online ? (
                <Banner tone="warn" title={i18n.t('attendance.clock.offlineTitle')}>
                  {i18n.t('attendance.clock.offlineBody')}
                </Banner>
              ) : null}
              {locationProblem ? (
                <Banner
                  tone="danger"
                  title={i18n.t(`attendance.location.${locationProblem}.title`)}
                >
                  <p>{i18n.t(`attendance.location.${locationProblem}.body`)}</p>
                  {locationProblem === 'denied' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        if (!openLocationSettings()) setLocationProblem('denied');
                      }}
                    >
                      {i18n.t('attendance.location.openSettings')}
                    </Button>
                  ) : null}
                </Banner>
              ) : null}
              {faceRefused ? (
                <Banner tone="danger" title={i18n.t(faceRefused)}>
                  {i18n.t('attendance.face.refusedBody')}
                </Banner>
              ) : null}
              {done ? (
                <Banner
                  tone={done.flagged ? 'warn' : 'success'}
                  title={
                    done.forName
                      ? i18n.t(
                          done.kind === 'in'
                            ? 'attendance.borrow.doneIn'
                            : 'attendance.borrow.doneOut',
                          { name: done.forName, time: done.time },
                        )
                      : i18n.t(
                          done.kind === 'in'
                            ? 'attendance.clock.doneIn'
                            : 'attendance.clock.doneOut',
                          { time: done.time },
                        )
                  }
                >
                  {done.flagged ? i18n.t('attendance.live.flaggedNote') : undefined}
                </Banner>
              ) : null}

              {enrolled ? (
                <Button
                  size="lg"
                  block
                  variant={store.nextKind === 'in' ? 'primary' : 'secondary'}
                  loading={locating || preparing || punch.isPending}
                  disabled={!online || !deviceId || punch.isPending || locating || preparing}
                  onClick={() => void begin(false)}
                >
                  {locating
                    ? i18n.t('attendance.clock.locating')
                    : i18n.t(
                        store.nextKind === 'in' ? 'attendance.clock.in' : 'attendance.clock.out',
                      )}
                </Button>
              ) : (
                <EnrollCard
                  status={face?.status ?? 'none'}
                  note={face?.rejectedNote ?? null}
                  disabled={!online}
                  onEnroll={() => startEnroll()}
                />
              )}
              {enrolled && face?.pending ? (
                <p className="text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('attendance.enroll.newPending')}
                </p>
              ) : null}
              <ul className="flex flex-col gap-0.5 text-old-label text-[var(--c-fg-muted)]">
                {store.rules.requireDevice ? (
                  <li>{i18n.t('attendance.rules.deviceLine')}</li>
                ) : null}
                {store.rules.requireGeo && store.rules.geo ? (
                  <li>{i18n.t('attendance.rules.geoLine', { radius: store.rules.geo.radiusM })}</li>
                ) : null}
                <li>{i18n.t('attendance.rules.faceOnlyLine')}</li>
                {store.rules.requireScene ? <li>{i18n.t('attendance.rules.sceneLine')}</li> : null}
              </ul>
              <Button
                variant="ghost"
                block
                disabled={!online || !deviceId || punch.isPending || locating || preparing}
                onClick={() => void begin(true)}
              >
                {i18n.t('attendance.borrow.open')}
              </Button>
              {enrolled ? (
                <Button variant="ghost" size="sm" onClick={() => startEnroll()}>
                  {i18n.t('attendance.enroll.redo')}
                </Button>
              ) : null}
              {me.data?.faceConsent ? (
                <Button variant="ghost" size="sm" onClick={() => setWithdrawOpen(true)}>
                  {i18n.t('attendance.consent.withdraw')}
                </Button>
              ) : null}
              <FaceConsentSheet
                open={consentFor !== null}
                pending={consentGive.isPending}
                onCancel={() => setConsentFor(null)}
                onAgree={() => {
                  const next = consentFor;
                  consentGive.mutate(
                    { version: ATTENDANCE_FACE_CONSENT_VERSION },
                    {
                      onSuccess: () => {
                        setConsentFor(null);
                        if (next === 'enroll') startEnroll(true);
                        else if (next) void begin(next.identify);
                      },
                      onError: errToast('attendance.errors.punchFailed'),
                    },
                  );
                }}
              />
              <ConfirmSheet
                open={withdrawOpen}
                title={i18n.t('attendance.consent.withdrawTitle')}
                body={i18n.t('attendance.consent.withdrawBody')}
                confirmLabel={i18n.t('attendance.consent.withdraw')}
                danger
                pending={consentWithdraw.isPending}
                onConfirm={() => consentWithdraw.mutate()}
                onCancel={() => setWithdrawOpen(false)}
              />
              <FaceEnrollSheet
                open={enrolling}
                storeId={storeId}
                onCancel={() => setEnrolling(false)}
                onDone={() => {
                  setEnrolling(false);
                  void utils.attendance.me.invalidate();
                }}
              />
              <PunchCamera
                open={camera !== null}
                kind={camera?.identify ? null : store.nextKind}
                turns={camera?.challenge?.steps ?? null}
                scene={store.rules.requireScene}
                identifying={camera?.identify ?? false}
                busy={punch.isPending}
                onCancel={() => setCamera(null)}
                onConfirm={(photos) => camera && send(camera, photos)}
              />
              <UpcomingShifts shifts={store.shifts} today={store.today} />
              <Sheet
                open={overtimeAsk !== null}
                onOpenChange={(open) => !open && setOvertimeAsk(null)}
                title={i18n.t('attendance.overtime.askTitle')}
                description={
                  overtimeAsk
                    ? i18n.t('attendance.overtime.askBody', {
                        duration: minutesText(i18n, overtimeAsk.minutes),
                      })
                    : ''
                }
              >
                <div className="flex flex-col gap-3 py-3">
                  <Textarea
                    rows={3}
                    maxLength={300}
                    value={overtimeReason}
                    onChange={(e) => setOvertimeReason(e.target.value)}
                    placeholder={i18n.t('attendance.overtime.reasonPlaceholder')}
                    aria-label={i18n.t('attendance.overtime.askTitle')}
                  />
                  <Button
                    block
                    disabled={overtimeReason.trim().length === 0 || !deviceId}
                    loading={punch.isPending}
                    onClick={() =>
                      overtimeAsk &&
                      punch.mutate({ ...overtimeAsk.vars, overtimeReason: overtimeReason.trim() })
                    }
                  >
                    {i18n.t('attendance.clock.out')}
                  </Button>
                </div>
              </Sheet>
            </>
          )
        }
      </DataState>
    </div>
  );
}

/** Before the first punch: enroll the face, wait for approval, or enroll again. */
function EnrollCard({
  status,
  note,
  disabled,
  onEnroll,
}: {
  status: 'none' | 'pending' | 'rejected' | 'approved';
  note: string | null;
  disabled: boolean;
  onEnroll: () => void;
}) {
  const i18n = useI18n();
  return (
    <section className="flex flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 ring-hairline">
      <div>
        <h2 className="text-old-h3 font-semibold text-[var(--c-fg)]">
          {i18n.t(`attendance.enroll.card.${status}.title`)}
        </h2>
        <p className="mt-1 text-old-body text-[var(--c-fg-muted)]">
          {i18n.t(`attendance.enroll.card.${status}.body`)}
        </p>
        {status === 'rejected' && note ? (
          <p className="mt-1 text-old-body text-[var(--c-fg)]">
            {i18n.t('attendance.enroll.card.note', { note })}
          </p>
        ) : null}
      </div>
      <Button
        size="lg"
        block
        variant={status === 'pending' ? 'secondary' : 'primary'}
        disabled={disabled}
        onClick={onEnroll}
      >
        {i18n.t(status === 'pending' ? 'attendance.enroll.redo' : 'attendance.enroll.start')}
      </Button>
    </section>
  );
}

type ShiftView = { id: string; date: string; start: string; end: string; note: string | null };

function TodayShift({ shifts, today }: { shifts: ShiftView[]; today: string }) {
  const i18n = useI18n();
  const todays = shifts.filter((x) => x.date === today);
  if (todays.length === 0) {
    return (
      <p className="mt-1 text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.clock.noShiftToday')}
      </p>
    );
  }
  return (
    <p className="mt-1 text-old-h3 font-semibold text-[var(--c-fg)]">
      {i18n.t('attendance.clock.shiftToday', {
        times: todays.map((x) => `${x.start}–${x.end}`).join(', '),
      })}
    </p>
  );
}

function UpcomingShifts({ shifts, today }: { shifts: ShiftView[]; today: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const next = shifts.filter((x) => x.date > today).slice(0, 7);
  if (next.length === 0) return null;
  return (
    <section className="mt-2">
      <h2 className="mb-1 text-old-label font-semibold text-[var(--c-fg-muted)]">
        {i18n.t('attendance.clock.upcoming')}
      </h2>
      <ul className="flex flex-col gap-1">
        {next.map((x) => (
          <li key={x.id} className="flex items-center justify-between text-old-body">
            <span className="text-[var(--c-fg)]">{dates.weekdayLong(x.date)}</span>
            <span className="tabular-nums text-[var(--c-fg-muted)]">
              {x.start}–{x.end}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
