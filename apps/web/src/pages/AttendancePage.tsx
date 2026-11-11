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
 *
 * Straight on (owner, 2026-11-07): nobody looks at the photos first. The
 * punch goes as soon as the last face frame is in, and its sheet shows the
 * result; for a colleague, whose punch it was, with "Not <name>" for two
 * minutes (attendance/usePunchFlow.ts, attendance/PunchSheet.tsx).
 */
import { useEffect, useState } from 'react';
import { Banner, Button, ConfirmSheet, DataState, EmptyState } from '@compass/ui';
import { ATTENDANCE_FACE_CONSENT_VERSION, locationVerdict } from '@compass/contracts/limits';
import type { CatalogKey } from '@compass/i18n';
import { haptic } from '../hooks/useTelegram';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { useStoreContext } from '../components/StoreSwitcher';
import { useDateFormat, useI18n } from '../hooks/useI18n';
import { useOnline } from '../hooks/useOnline';
import { attendanceDeviceId } from '../lib/attendanceDevice';
import {
  currentLocation,
  distanceMeters,
  isLocationError,
  openLocationSettings,
  type Fix as LocationFix,
  type LocationFailure,
} from '../lib/attendanceLocation';
import { GeoMap, type GeoArea } from '../components/geo/GeoMap';
import { useErrToast } from '../lib/errToast';
import { trpc } from '../lib/trpc';
import { loadFaceTracker } from '../lib/faceTracker';
import { FaceConsentSheet } from './attendance/FaceConsentSheet';
import { FaceEnrollSheet } from './attendance/FaceEnrollSheet';
import { PunchSheet, type PunchResult } from './attendance/PunchSheet';
import { usePunchFlow } from './attendance/usePunchFlow';

type Fix = { lat: number; lng: number; accuracy: number };

type Far =
  | { kind: 'outside'; distance: number; radius: number }
  | { kind: 'inaccurate'; accuracy: number };

/**
 * The server's own location rule (locationVerdict), checked before the
 * camera: the phone never refuses what the server would take.
 */
function tooFar(fix: Fix, area: GeoArea): Far | null {
  const distance = Math.round(distanceMeters(fix, area));
  const verdict = locationVerdict({
    distanceM: distance,
    accuracyM: fix.accuracy,
    radiusM: area.radiusM,
  });
  if (verdict === 'inaccurate') return { kind: 'inaccurate', accuracy: Math.round(fix.accuracy) };
  if (verdict === 'outside') return { kind: 'outside', distance, radius: area.radiusM };
  return null;
}

/** The page's line for the latest punch, once its sheet has closed. */
function doneTitle(i18n: ReturnType<typeof useI18n>, r: PunchResult): string {
  if (r.already) {
    return r.forName
      ? i18n.t(
          r.kind === 'in' ? 'attendance.punch.alreadyInFor' : 'attendance.punch.alreadyOutFor',
          {
            name: r.forName,
            time: r.time,
          },
        )
      : i18n.t(r.kind === 'in' ? 'attendance.punch.alreadyIn' : 'attendance.punch.alreadyOut', {
          time: r.time,
        });
  }
  return r.forName
    ? i18n.t(r.kind === 'in' ? 'attendance.borrow.doneIn' : 'attendance.borrow.doneOut', {
        name: r.forName,
        time: r.time,
      })
    : i18n.t(r.kind === 'in' ? 'attendance.clock.doneIn' : 'attendance.clock.doneOut', {
        time: r.time,
      });
}

export function AttendancePage() {
  const i18n = useI18n();
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
  const storeId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;

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
    // Review UI-14 / ATT-19: a tab page shows no title (UI-12). The nav
    // names it, the Shell renders the hidden <h1>, and the store is the
    // top bar's store chip. The visible title was a second <h1>.
    <div className="flex flex-col pb-6 pt-3">
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
  // Too far from the store, or a fix too coarse to tell, before the camera.
  const [outside, setOutside] = useState<Far | null>(null);

  useEffect(() => {
    void attendanceDeviceId().then(setDeviceId);
  }, []);

  const me = trpc.attendance.me.useQuery(
    { deviceId: deviceId ?? undefined },
    { enabled: deviceId !== null, refetchInterval: 60_000 },
  );
  // The face-check consent, asked before enrolling or the first face punch.
  const [consentFor, setConsentFor] = useState<{ identify: boolean } | 'enroll' | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
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

  const store = me.data?.stores.find((x) => x.storeId === storeId) ?? null;
  // Fetch the face tracker while the page is open, not when the camera
  // is: it is a few MB the first time.
  useEffect(() => {
    void loadFaceTracker();
  }, []);
  const face = me.data?.face ?? null;
  const enrolled = face?.status === 'approved';

  /** Agree first, then the ring. */
  const startEnroll = (consented = false) => {
    if (!consented && !me.data?.faceConsent) {
      setConsentFor('enroll');
      return;
    }
    setEnrolling(true);
  };

  // The punch itself, in its sheet: camera, check, result (2026-11-07).
  const flow = usePunchFlow({
    storeId,
    deviceId,
    onConsent: () => setConsentFor('enroll'),
    onEnroll: () => setEnrolling(true),
    onAgain: (identify, notice) => void begin(identify, notice),
  });

  const begin = async (identify: boolean, notice?: CatalogKey) => {
    if (!store || !deviceId) return;
    // The phone's own person agrees and enrolls first; a colleague did so
    // on their own phone (the server checks).
    if (!identify && (!me.data?.faceConsent || !enrolled)) {
      startEnroll();
      return;
    }
    setLocationProblem(null);
    setOutside(null);
    flow.clearLast();
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
      // Clearly too far, or too coarse to tell: said before the camera, not
      // after a face check that cannot count (2026-11-07). The server decides.
      const far = store.rules.geo ? tooFar(location, store.rules.geo) : null;
      if (far) {
        haptic('error');
        setOutside(far);
        return;
      }
    }
    await flow.start(identify, location, identify ? null : store.nextKind, notice);
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
                <TodayShift shifts={store.shifts} today={store.today} now={me.dataUpdatedAt} />
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
                          {/* ATT-05: the last 24 hours, so yesterday's evening too. */}
                          {p.date !== store.today ? (
                            <span className="mr-1 font-normal text-[var(--c-fg-muted)]">
                              {i18n.t('attendance.clock.yesterday')}
                            </span>
                          ) : null}
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
              {outside ? (
                <Banner
                  tone="danger"
                  title={i18n.t(
                    outside.kind === 'outside'
                      ? 'attendance.location.outside.title'
                      : 'attendance.location.inaccurate.title',
                  )}
                >
                  {outside.kind === 'outside'
                    ? i18n.t('attendance.errors.outsideArea', {
                        distance: outside.distance,
                        radius: outside.radius,
                      })
                    : i18n.t('attendance.errors.locationInaccurate', {
                        accuracy: outside.accuracy,
                      })}
                </Banner>
              ) : null}
              {flow.last ? (
                <Banner
                  tone={flow.last.flagged ? 'warn' : 'success'}
                  title={doneTitle(i18n, flow.last)}
                  action={
                    flow.last.forName && flow.last.undoUntil ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={flow.undoPending}
                        onClick={flow.undo}
                      >
                        {i18n.t('attendance.punch.notThem', { name: flow.last.forName })}
                      </Button>
                    ) : undefined
                  }
                >
                  {flow.last.flagged ? i18n.t('attendance.live.flaggedNote') : undefined}
                </Banner>
              ) : null}

              {enrolled ? (
                <Button
                  size="lg"
                  block
                  variant={store.nextKind === 'in' ? 'primary' : 'secondary'}
                  loading={locating || flow.preparing}
                  disabled={!online || !deviceId || locating || flow.preparing || flow.open}
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
              {store.rules.requireGeo && store.rules.geo ? (
                <WhereAmI area={store.rules.geo} />
              ) : null}
              <ul className="flex flex-col gap-0.5 text-old-label text-[var(--c-fg-muted)]">
                {store.rules.requireDevice ? (
                  <li>{i18n.t('attendance.rules.deviceLine')}</li>
                ) : null}
                {store.rules.requireGeo && store.rules.geo ? (
                  <li>{i18n.t('attendance.rules.geoLine', { radius: store.rules.geo.radiusM })}</li>
                ) : null}
                <li>{i18n.t('attendance.rules.faceOnlyLine')}</li>
              </ul>
              <Button
                variant="ghost"
                block
                disabled={!online || !deviceId || locating || flow.preparing || flow.open}
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
              <PunchSheet
                {...flow.sheet}
                title={i18n.t(
                  flow.sheet.identifying
                    ? 'attendance.punch.colleagueTitle'
                    : flow.kind === 'out'
                      ? 'attendance.clock.out'
                      : 'attendance.clock.in',
                )}
                storeName={store.storeName}
              />
              <UpcomingShifts shifts={store.shifts} today={store.today} />
            </>
          )
        }
      </DataState>
    </div>
  );
}

/**
 * The store's clock-in area on a map, and on request where the phone is
 * now: whether a punch here would be inside it (2026-11-07), by the
 * punch's own rule (locationVerdict, review ATT-08). The server decides
 * at the punch; this is only a look.
 */
function WhereAmI({ area }: { area: GeoArea }) {
  const i18n = useI18n();
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<LocationFailure | null>(null);
  const locate = async () => {
    setLocating(true);
    setProblem(null);
    try {
      setFix(await currentLocation());
    } catch (e) {
      setProblem(isLocationError(e) ? e.reason : 'unavailable');
    } finally {
      setLocating(false);
    }
  };
  const distance = fix ? Math.round(distanceMeters(fix, area)) : null;
  const verdict =
    fix && distance !== null
      ? locationVerdict({ distanceM: distance, accuracyM: fix.accuracy, radiusM: area.radiusM })
      : null;
  const inside = verdict === 'inside';
  return (
    <section className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface)] p-3 ring-hairline">
      <GeoMap
        area={area}
        points={
          fix
            ? [
                {
                  lat: fix.lat,
                  lng: fix.lng,
                  accuracyM: Math.round(fix.accuracy),
                  tone: inside ? 'inside' : 'outside',
                },
              ]
            : []
        }
        label={i18n.t('attendance.map.label')}
        className="h-48 w-full overflow-hidden rounded-[var(--r-utility)]"
      />
      {fix && distance !== null ? (
        <p
          className={`text-old-body font-semibold ${inside ? 'text-[var(--c-success-ink)]' : 'text-[var(--c-danger-ink)]'}`}
          aria-live="polite"
        >
          {verdict === 'inaccurate' ? (
            // What the punch would say: too coarse to place anyone.
            i18n.t('attendance.errors.locationInaccurate', { accuracy: Math.round(fix.accuracy) })
          ) : (
            <>
              {inside
                ? i18n.t('attendance.map.inside', { m: distance })
                : i18n.t('attendance.map.outside', { m: distance - area.radiusM })}
              <span className="block text-old-label font-normal text-[var(--c-fg-muted)]">
                {i18n.t('attendance.map.accuracy', { m: Math.round(fix.accuracy) })}
              </span>
            </>
          )}
        </p>
      ) : null}
      {problem ? (
        <p className="text-old-label text-[var(--c-danger-ink)]">
          {i18n.t(`attendance.location.${problem}.title`)}
        </p>
      ) : null}
      <Button variant="secondary" size="sm" loading={locating} onClick={() => void locate()}>
        {i18n.t('attendance.map.whereAmI')}
      </Button>
    </section>
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

type ShiftView = {
  id: string;
  date: string;
  start: string;
  end: string;
  endsAt: string;
  note: string | null;
};

/**
 * Today's shifts, and a night shift begun yesterday while it is still on
 * (ATT-05): at 02:00 in a 22:00–06:00 shift the page said "no shift today".
 * `now`: when the page last read the shifts.
 */
function TodayShift({ shifts, today, now }: { shifts: ShiftView[]; today: string; now: number }) {
  const i18n = useI18n();
  const times = (list: ShiftView[]) => list.map((x) => `${x.start}–${x.end}`).join(', ');
  const carried = shifts.filter((x) => x.date < today && Date.parse(x.endsAt) > now);
  const todays = shifts.filter((x) => x.date === today);
  return (
    <>
      {carried.length > 0 ? (
        <p className="mt-1 text-old-h3 font-semibold text-[var(--c-fg)]">
          {i18n.t('attendance.clock.shiftFromYesterday', { times: times(carried) })}
        </p>
      ) : null}
      {todays.length > 0 ? (
        <p className="mt-1 text-old-h3 font-semibold text-[var(--c-fg)]">
          {i18n.t('attendance.clock.shiftToday', { times: times(todays) })}
        </p>
      ) : carried.length === 0 ? (
        <p className="mt-1 text-old-h3 font-semibold text-[var(--c-fg)]">
          {i18n.t('attendance.clock.noShiftToday')}
        </p>
      ) : null}
    </>
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
