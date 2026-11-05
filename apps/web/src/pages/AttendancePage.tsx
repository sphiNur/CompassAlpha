/**
 * AttendancePage — clock in / out (2026-11-05).
 *
 * The tab shows only to members switched on for clocking
 * (`attendance.clock`). Managers plan and review attendance under
 * Admin → Attendance (pages/attendance/AttendanceAdmin.tsx), so the
 * bottom bar does not grow for them. A punch is sent live with
 * the phone's id and, when the store asks for it, its location; the
 * server checks both and the store network, and records its own time.
 * Nothing is queued offline: a clock-in must happen where and when it
 * says it did.
 */
import { useEffect, useState } from 'react';
import { Banner, Button, DataState, EmptyState, PageHeader } from '@compass/ui';
import { haptic } from '../hooks/useTelegram';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { useStoreContext } from '../components/StoreSwitcher';
import { useDateFormat, useI18n } from '../hooks/useI18n';
import { useOnline } from '../hooks/useOnline';
import { attendanceDeviceId, devicePlatform } from '../lib/attendanceDevice';
import { currentLocation, isLocationError, openLocationSettings } from '../lib/attendanceLocation';
import { useErrToast } from '../lib/errToast';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';

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
  const [done, setDone] = useState<{ kind: 'in' | 'out'; time: string } | null>(null);

  useEffect(() => {
    void attendanceDeviceId().then(setDeviceId);
  }, []);

  const me = trpc.attendance.me.useQuery(
    { deviceId: deviceId ?? undefined },
    { enabled: deviceId !== null, refetchInterval: 60_000 },
  );
  const punch = trpc.attendance.punch.useMutation({
    onSuccess: (data) => {
      haptic('success');
      setDone({ kind: data.kind, time: data.time });
      void utils.attendance.me.invalidate();
    },
    onError: errToast('attendance.errors.punchFailed'),
  });

  const store = me.data?.stores.find((x) => x.storeId === storeId) ?? null;

  const onPunch = async () => {
    if (!store || !deviceId) return;
    setLocationProblem(null);
    let location: { lat: number; lng: number; accuracy: number } | null = null;
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
    punch.mutate({
      storeId,
      kind: store.nextKind,
      deviceId,
      platform: devicePlatform(),
      location,
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
              {done ? (
                <Banner
                  tone="success"
                  title={i18n.t(
                    done.kind === 'in' ? 'attendance.clock.doneIn' : 'attendance.clock.doneOut',
                    { time: done.time },
                  )}
                />
              ) : null}

              <Button
                size="lg"
                block
                variant={store.nextKind === 'in' ? 'primary' : 'secondary'}
                loading={locating || punch.isPending}
                disabled={!online || !deviceId || punch.isPending || locating}
                onClick={() => void onPunch()}
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
                {store.rules.requireIp ? <li>{i18n.t('attendance.rules.ipLine')}</li> : null}
              </ul>
              <UpcomingShifts shifts={store.shifts} today={store.today} />
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
