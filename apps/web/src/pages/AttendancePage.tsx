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
 */
import { useEffect, useRef, useState } from 'react';
import { Banner, Button, DataState, EmptyState, PageHeader, Sheet, Textarea } from '@compass/ui';
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
import { BorrowSheet } from './attendance/BorrowSheet';
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
    forMember: { id: string; name: string; kind: 'in' | 'out' } | null;
    challenge: { token: string; steps: Turn[] } | null;
  };
  type PunchVars = Parameters<typeof punch.mutate>[0];
  // A clock-out well past the shift asks why (phase 2): the server refuses
  // it without a reason, and the same punch is sent again with one.
  const [overtimeAsk, setOvertimeAsk] = useState<{ minutes: number; vars: PunchVars } | null>(null);
  // The store asks for a face and a surroundings photo with each punch.
  const [camera, setCamera] = useState<Attempt | null>(null);
  const [overtimeReason, setOvertimeReason] = useState('');
  // Liveness (2026-11-06): after two failed tries the person may clock
  // anyway; the punch is flagged and the managers are told.
  const [liveFails, setLiveFails] = useState(0);
  const [lastFailed, setLastFailed] = useState<PunchVars | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [borrowOpen, setBorrowOpen] = useState(false);
  const challenge = trpc.attendance.livenessChallenge.useMutation();
  const punch = trpc.attendance.punch.useMutation({
    onSuccess: (data, vars) => {
      haptic('success');
      setCamera(null);
      setOvertimeAsk(null);
      setOvertimeReason('');
      setLiveFails(0);
      setLastFailed(null);
      setDone({
        kind: data.kind,
        time: data.time,
        forName: vars.forMemberId ? (doneNames.current.get(vars.forMemberId) ?? null) : null,
        flagged: data.liveness === 'fail' || data.newDevice,
      });
      void utils.attendance.me.invalidate();
      void utils.attendance.colleagues.invalidate();
    },
    onError: (err, vars) => {
      setCamera(null);
      const key = serverErrorKey(err);
      if (key === 'attendance.errors.overtimeReasonRequired') {
        haptic('warning');
        setOvertimeAsk({ minutes: Number(errorVars(err).minutes ?? 0), vars });
        return;
      }
      if (key === 'attendance.errors.livenessFailed') {
        haptic('error');
        setLiveFails((n) => n + 1);
        setLastFailed(vars);
        return;
      }
      errToast('attendance.errors.punchFailed')(err);
    },
  });
  const doneNames = useRef(new Map<string, string>());

  const store = me.data?.stores.find((x) => x.storeId === storeId) ?? null;
  // Fetch the liveness face tracker while the page is open, not when the
  // camera is: it is a few MB the first time.
  const wantTracker = store?.rules.requireLiveness ?? false;
  useEffect(() => {
    if (wantTracker) void loadFaceTracker();
  }, [wantTracker]);

  const begin = async (forMember: Attempt['forMember']) => {
    if (!store || !deviceId) return;
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
    if (!store.rules.requirePhoto && !forMember) {
      send({ location, forMember: null, challenge: null }, undefined);
      return;
    }
    let ch: Attempt['challenge'] = null;
    if (store.rules.requireLiveness || forMember) {
      setPreparing(true);
      try {
        const c = await challenge.mutateAsync({ storeId, forMemberId: forMember?.id });
        ch = { token: c.token, steps: c.steps };
      } catch (err) {
        errToast('attendance.errors.punchFailed')(err);
        return;
      } finally {
        setPreparing(false);
      }
    }
    if (forMember) doneNames.current.set(forMember.id, forMember.name);
    setCamera({ location, forMember, challenge: ch });
  };

  const send = (attempt: Attempt, photos: PunchPhotos | undefined) => {
    if (!store || !deviceId) return;
    punch.mutate({
      storeId,
      kind: attempt.forMember?.kind ?? store.nextKind,
      deviceId,
      platform: devicePlatform(),
      location: attempt.location,
      photos: photos ? { face: photos.face, scene: photos.scene } : undefined,
      liveness:
        attempt.challenge && photos?.left && photos.right
          ? { token: attempt.challenge.token, left: photos.left, right: photos.right }
          : undefined,
      forMemberId: attempt.forMember?.id,
    });
  };

  /** The failed punch again, flagged: a fresh challenge, the same photos. */
  const sendAnyway = async () => {
    if (!lastFailed?.liveness) return;
    try {
      const c = await challenge.mutateAsync({ storeId });
      punch.mutate({
        ...lastFailed,
        liveness: { ...lastFailed.liveness, token: c.token },
        acceptLivenessFail: true,
      });
    } catch (err) {
      errToast('attendance.errors.punchFailed')(err);
    }
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
              {liveFails > 0 && lastFailed ? (
                <Banner tone="danger" title={i18n.t('attendance.live.failedTitle')}>
                  <p>{i18n.t('attendance.live.failedBody')}</p>
                  {liveFails >= 2 && !lastFailed.forMemberId ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      loading={punch.isPending || challenge.isPending}
                      onClick={() => void sendAnyway()}
                    >
                      {i18n.t('attendance.live.clockAnyway')}
                    </Button>
                  ) : null}
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

              <Button
                size="lg"
                block
                variant={store.nextKind === 'in' ? 'primary' : 'secondary'}
                loading={locating || preparing || punch.isPending}
                disabled={!online || !deviceId || punch.isPending || locating || preparing}
                onClick={() => void begin(null)}
              >
                {locating
                  ? i18n.t('attendance.clock.locating')
                  : i18n.t(
                      store.nextKind === 'in' ? 'attendance.clock.in' : 'attendance.clock.out',
                    )}
              </Button>
              <ul className="flex flex-col gap-0.5 text-old-label text-[var(--c-fg-muted)]">
                {store.rules.requireDevice ? (
                  <li>{i18n.t('attendance.rules.deviceLine')}</li>
                ) : null}
                {store.rules.requireGeo && store.rules.geo ? (
                  <li>{i18n.t('attendance.rules.geoLine', { radius: store.rules.geo.radiusM })}</li>
                ) : null}
                {store.rules.requirePhoto ? <li>{i18n.t('attendance.rules.photoLine')}</li> : null}
                {store.rules.requireLiveness ? (
                  <li>{i18n.t('attendance.rules.livenessLine')}</li>
                ) : null}
              </ul>
              {store.rules.requireFace ? (
                <Button
                  variant="ghost"
                  block
                  disabled={!online || !deviceId || punch.isPending || locating || preparing}
                  onClick={() => setBorrowOpen(true)}
                >
                  {i18n.t('attendance.borrow.open')}
                </Button>
              ) : null}
              <BorrowSheet
                open={borrowOpen}
                storeId={storeId}
                onClose={() => setBorrowOpen(false)}
                onPick={(m) => {
                  setBorrowOpen(false);
                  void begin({ id: m.memberId, name: m.name, kind: m.nextKind });
                }}
              />
              <PunchCamera
                open={camera !== null}
                kind={camera?.forMember?.kind ?? store.nextKind}
                faceCheck={store.rules.requireFace}
                turns={camera?.challenge?.steps ?? null}
                forName={camera?.forMember?.name ?? null}
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
