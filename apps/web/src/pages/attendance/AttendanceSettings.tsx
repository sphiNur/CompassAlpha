/**
 * Attendance settings for one store (2026-11-05): who clocks (the
 * per-member switch), unbinding a lost phone, and the store's clock-in
 * rules — bound phone, location radius, grace minutes.
 *
 * Face only (2026-11-06): the face check is always on; each person's face
 * enrollment shows here, and a manager can ask for it again.
 */
import { useState } from 'react';
import type { EnrollPose } from '@compass/contracts/schemas/faceEnroll';
import {
  ATTENDANCE_GRACE_MINUTES,
  ATTENDANCE_OVERTIME_AFTER_MINUTES,
  ATTENDANCE_RADIUS_M,
  settlementMoneyProblem,
  wholeNumberIn,
} from '@compass/contracts/limits';
import { Button, DataState, Field, Input, Switch, useToast } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../lib/telegram';
import { currentLocation, isLocationError } from '../../lib/attendanceLocation';
import { sheetMemberOrder } from '../../lib/attendanceFormat';
import { useErrToast } from '../../hooks/useErrToast';
import { GeoMap } from '../../components/geo/GeoMap';
import type { AttendancePolicyData } from '@compass/api/src/trpc/routers/attendance';
import { trpc } from '../../lib/trpc';
import { orgToday } from '../../lib/calendarDate';
import { useAuthStore } from '../../stores/authStore';
import { nativeConfirm } from '../admin/shared';
import { addDays } from './AttendanceManage';

type Policy = AttendancePolicyData;

export function AttendanceSettings({ storeId }: { storeId: string }) {
  return (
    <div className="flex flex-col gap-5 px-4">
      <PeopleBlock storeId={storeId} />
      <RulesBlock storeId={storeId} />
    </div>
  );
}

function PeopleBlock({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  // COREWEB2-21: the org's today, not the phone's.
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const t = orgToday(orgTimeZone);
  // The sheet's member list carries the switch and the bound phone.
  const sheet = trpc.attendance.sheet.useQuery({ storeId, from: addDays(t, -1), to: t });
  const memberSet = trpc.attendance.memberSet.useMutation({
    onSuccess: () => {
      haptic('success');
      void utils.attendance.sheet.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const resetDevice = trpc.attendance.resetDevice.useMutation({
    onSuccess: () => {
      haptic('success');
      void utils.attendance.sheet.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });

  return (
    <section>
      <h2 className="mb-1 text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.settings.people')}
      </h2>
      <p className="mb-2 text-old-label text-[var(--c-fg-muted)]">
        {i18n.t('attendance.settings.peopleHint')}
      </p>
      <DataState query={sheet}>
        {(data) => (
          <ul className="flex flex-col gap-2">
            {data.members
              .filter((m) => m.inStore)
              .sort(sheetMemberOrder(i18n.locale))
              .map((m) => (
                <li
                  key={m.memberId}
                  className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline"
                >
                  <Switch
                    label={m.name}
                    hint={
                      m.deviceBoundAt
                        ? i18n.t('attendance.settings.deviceBound')
                        : m.enabled
                          ? i18n.t('attendance.settings.deviceNotYet')
                          : undefined
                    }
                    checked={m.enabled}
                    disabled={memberSet.isPending}
                    onChange={(e) =>
                      memberSet.mutate({ storeId, memberId: m.memberId, enabled: e.target.checked })
                    }
                  />
                  {m.deviceBoundAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1"
                      loading={
                        resetDevice.isPending && resetDevice.variables?.memberId === m.memberId
                      }
                      onClick={() =>
                        nativeConfirm(
                          i18n.t('attendance.settings.resetDeviceConfirm', { name: m.name }),
                          () => resetDevice.mutate({ storeId, memberId: m.memberId }),
                        )
                      }
                    >
                      {i18n.t('attendance.settings.resetDevice')}
                    </Button>
                  ) : null}
                  {m.enabled ? (
                    <WageField
                      storeId={storeId}
                      memberId={m.memberId}
                      current={m.dailyWage}
                      own={m.own}
                      today={data.today}
                    />
                  ) : null}
                  {m.enabled ? (
                    <FaceEnrollLine
                      storeId={storeId}
                      memberId={m.memberId}
                      name={m.name}
                      status={m.face}
                    />
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </DataState>
    </section>
  );
}

/** The person's face enrollment: its photos on demand, or deleted so they enroll again. */
function FaceEnrollLine({
  storeId,
  memberId,
  name,
  status,
}: {
  storeId: string;
  memberId: string;
  name: string;
  status: 'approved' | 'pending' | 'rejected' | 'none';
}) {
  const i18n = useI18n();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [show, setShow] = useState(false);
  const has = status === 'approved' || status === 'pending';
  const photos = trpc.attendance.faceEnrollment.useQuery(
    { storeId, memberId },
    { enabled: show && has },
  );
  const reset = trpc.attendance.faceEnrollReset.useMutation({
    onSuccess: () => {
      haptic('success');
      setShow(false);
      void utils.attendance.sheet.invalidate();
      void utils.attendance.faceEnrollment.invalidate();
      void utils.attendance.reviewQueue.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  // The one in use, else the one waiting.
  const inUse = photos.data?.find((e) => e.status === 'approved') ?? photos.data?.[0];
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t(`attendance.enroll.status.${status}`)}
        </span>
        {has ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setShow(!show)}>
              {i18n.t(show ? 'attendance.face.hideRef' : 'attendance.face.showRef')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={reset.isPending}
              onClick={() =>
                nativeConfirm(i18n.t('attendance.enroll.resetConfirm', { name }), () =>
                  reset.mutate({ storeId, memberId }),
                )
              }
            >
              {i18n.t('attendance.enroll.reset')}
            </Button>
          </>
        ) : null}
      </div>
      {show && inUse ? <EnrollPhotos photos={inUse.photos} name={name} /> : null}
    </div>
  );
}

/** An enrollment's six photos in a row. */
export function EnrollPhotos({
  photos,
  name,
}: {
  photos: { pose: EnrollPose; src: string }[];
  name: string;
}) {
  const i18n = useI18n();
  return (
    <div className="grid grid-cols-5 gap-1">
      {photos.map((p) => (
        <img
          key={p.pose}
          src={p.src}
          alt={i18n.t('attendance.enroll.photoAlt', {
            name,
            pose: i18n.t(`attendance.enroll.pose.${p.pose}`),
          })}
          className="aspect-[3/4] w-full rounded-[var(--r-utility)] object-cover"
        />
      ))}
    </div>
  );
}

/** A person's daily wage from today on (phase 2); past days keep their rate. */
function WageField({
  storeId,
  memberId,
  current,
  own,
  today,
}: {
  storeId: string;
  memberId: string;
  current: string | null;
  /** The manager's own wage: only a super admin sets it (2026-11-07). */
  own: boolean;
  /** The store's today, as the server counts it: the new wage starts then
   *  (COREWEB2-21; it was the phone's date). */
  today: string;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const shown = current ? String(Number(current)) : '';
  // The number field hands on its normalised reading ("1 500,5" → "1500.5").
  const [text, setText] = useState(shown);
  // Review CONF-10: the server's rule for a daily wage (SettlementMoneySchema).
  const valid = settlementMoneyProblem(text) === null;
  const save = trpc.attendance.payRateSet.useMutation({
    onSuccess: () => {
      haptic('success');
      toast.success(i18n.t('attendance.settings.wageSaved'));
      void utils.attendance.sheet.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  return (
    <div className="mt-2 flex items-end gap-2">
      <Field
        label={i18n.t('attendance.settings.dailyWage')}
        hint={own ? i18n.t('attendance.sheet.ownHint') : undefined}
        className="min-w-0 flex-1"
      >
        <Input
          type="number"
          // The save button sits beside the field; the red edge marks a
          // wage the server would refuse, a line under it would push the
          // button down.
          formatError="none"
          value={text}
          disabled={own}
          invalid={text !== '' && !valid}
          placeholder={i18n.t('attendance.settings.dailyWageNotSet')}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {own ? null : (
        <Button
          size="sm"
          variant="secondary"
          disabled={!valid || text === shown}
          loading={save.isPending}
          onClick={() => save.mutate({ storeId, memberId, dailyWage: text, effectiveFrom: today })}
        >
          {i18n.t('common.save')}
        </Button>
      )}
    </div>
  );
}

function RulesBlock({ storeId }: { storeId: string }) {
  const policy = trpc.attendance.policyGet.useQuery({ storeId });
  return (
    <DataState query={policy}>
      {(data) => <RulesForm key={storeId} storeId={storeId} initial={data} />}
    </DataState>
  );
}

function RulesForm({ storeId, initial }: { storeId: string; initial: Policy }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [requireDevice, setRequireDevice] = useState(initial.requireDevice);
  const [requireGeo, setRequireGeo] = useState(initial.requireGeo);
  const [geo, setGeo] = useState(initial.geo);
  const [radius, setRadius] = useState(String(initial.geo?.radiusM ?? 100));
  const [grace, setGrace] = useState(String(initial.graceMinutes));
  const [overtimeAfter, setOvertimeAfter] = useState(String(initial.overtimeAfterMinutes));
  const [locating, setLocating] = useState(false);

  const save = trpc.attendance.policySave.useMutation({
    onSuccess: () => {
      haptic('success');
      toast.success(i18n.t('attendance.settings.saved'));
      void utils.attendance.policyGet.invalidate();
      void utils.attendance.me.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });

  const radiusNum = wholeNumberIn(radius, ATTENDANCE_RADIUS_M);
  const graceNum = wholeNumberIn(grace, ATTENDANCE_GRACE_MINUTES);
  const overtimeNum = wholeNumberIn(overtimeAfter, ATTENDANCE_OVERTIME_AFTER_MINUTES);
  const radiusOk = radiusNum !== null;
  const graceOk = graceNum !== null;
  const overtimeOk = overtimeNum !== null;
  // A saved location always goes with a valid radius, whether or not the
  // rule is on: a bad radius used to save the location away (review
  // 2026-11-07).
  const canSave =
    graceOk && overtimeOk && (!requireGeo || geo !== null) && (geo === null || radiusOk);

  const takeCurrentLocation = async () => {
    setLocating(true);
    try {
      const fix = await currentLocation();
      setGeo({ lat: fix.lat, lng: fix.lng, radiusM: radiusNum ?? 100 });
      if (fix.accuracy > 100)
        toast.info(i18n.t('attendance.settings.geoCoarse', { m: Math.round(fix.accuracy) }));
    } catch (e) {
      toast.error(
        i18n.t(`attendance.location.${isLocationError(e) ? e.reason : 'unavailable'}.title`),
      );
    } finally {
      setLocating(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.settings.rules')}
      </h2>

      <div className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline">
        <Switch
          label={i18n.t('attendance.settings.requireDevice')}
          hint={i18n.t('attendance.settings.requireDeviceHint')}
          checked={requireDevice}
          onChange={(e) => setRequireDevice(e.target.checked)}
        />
      </div>

      <div className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline">
        <p className="text-old-body font-semibold text-[var(--c-fg)]">
          {i18n.t('attendance.settings.faceOnly')}
        </p>
        <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('attendance.settings.faceOnlyHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline">
        <Switch
          label={i18n.t('attendance.settings.requireGeo')}
          hint={i18n.t('attendance.settings.requireGeoHint')}
          checked={requireGeo}
          onChange={(e) => setRequireGeo(e.target.checked)}
        />
        {requireGeo || geo ? (
          <>
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {geo
                ? i18n.t('attendance.settings.geoSet', {
                    lat: geo.lat.toFixed(5),
                    lng: geo.lng.toFixed(5),
                  })
                : i18n.t('attendance.settings.geoNotSet')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              loading={locating}
              onClick={() => void takeCurrentLocation()}
            >
              {i18n.t('attendance.settings.useHere')}
            </Button>
            {geo ? (
              <>
                <GeoMap
                  area={radiusNum === null ? geo : { ...geo, radiusM: radiusNum }}
                  onAreaMove={(lat, lng) => setGeo({ ...geo, lat, lng })}
                  label={i18n.t('attendance.map.label')}
                />
                <p className="text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('attendance.map.dragHint')}
                </p>
              </>
            ) : null}
            <Field
              label={i18n.t('attendance.settings.radius')}
              hint={i18n.t('attendance.settings.radiusHint')}
            >
              <Input
                type="number"
                inputMode="numeric"
                value={radius}
                invalid={!radiusOk}
                onChange={(e) => {
                  setRadius(e.target.value);
                  const n = wholeNumberIn(e.target.value, ATTENDANCE_RADIUS_M);
                  if (geo && n !== null) setGeo({ ...geo, radiusM: n });
                }}
              />
            </Field>
          </>
        ) : null}
      </div>

      <div className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline">
        <Field
          label={i18n.t('attendance.settings.grace')}
          hint={i18n.t('attendance.settings.graceHint')}
        >
          <Input
            type="number"
            inputMode="numeric"
            value={grace}
            invalid={!graceOk}
            onChange={(e) => setGrace(e.target.value)}
          />
        </Field>
        <Field
          label={i18n.t('attendance.settings.overtimeAfter')}
          hint={i18n.t('attendance.settings.overtimeAfterHint')}
          className="mt-3"
        >
          <Input
            type="number"
            inputMode="numeric"
            value={overtimeAfter}
            invalid={!overtimeOk}
            onChange={(e) => setOvertimeAfter(e.target.value)}
          />
        </Field>
      </div>

      <Button
        block
        disabled={!canSave}
        loading={save.isPending}
        onClick={() => {
          if (graceNum === null || overtimeNum === null) return;
          save.mutate({
            storeId,
            requireDevice,
            requireGeo,
            requireScene: false,
            geo: geo ? { ...geo, radiusM: radiusNum ?? geo.radiusM } : null,
            graceMinutes: graceNum,
            overtimeAfterMinutes: overtimeNum,
          });
        }}
      >
        {i18n.t('common.save')}
      </Button>
    </section>
  );
}
