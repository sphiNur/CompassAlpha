/**
 * Attendance settings for one store (2026-11-05): who clocks (the
 * per-member switch), unbinding a lost phone, and the store's clock-in
 * rules — bound phone, location radius, grace minutes.
 */
import { useState } from 'react';
import {
  Button,
  DataState,
  Field,
  Input,
  Switch,
  normalizeDecimalInput,
  useToast,
} from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { currentLocation, isLocationError } from '../../lib/attendanceLocation';
import { useErrToast } from '../../lib/errToast';
import type { AttendancePolicyData } from '@compass/api/src/trpc/routers/attendance';
import { trpc } from '../../lib/trpc';
import { nativeConfirm } from '../admin/shared';
import { addDays } from './AttendanceManage';

type Policy = AttendancePolicyData;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  const t = today();
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
                    <WageField storeId={storeId} memberId={m.memberId} current={m.dailyWage} />
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </DataState>
    </section>
  );
}

/** A person's daily wage from today on (phase 2); past days keep their rate. */
function WageField({
  storeId,
  memberId,
  current,
}: {
  storeId: string;
  memberId: string;
  current: string | null;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const shown = current ? String(Number(current)) : '';
  const [text, setText] = useState(shown);
  const value = normalizeDecimalInput(text);
  const valid = /^\d{1,12}(\.\d{1,2})?$/.test(value);
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
      <Field label={i18n.t('attendance.settings.dailyWage')} className="min-w-0 flex-1">
        <Input
          inputMode="decimal"
          value={text}
          invalid={text !== '' && !valid}
          placeholder={i18n.t('attendance.settings.dailyWageNotSet')}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Button
        size="sm"
        variant="secondary"
        disabled={!valid || value === shown}
        loading={save.isPending}
        onClick={() => save.mutate({ storeId, memberId, dailyWage: value, effectiveFrom: today() })}
      >
        {i18n.t('common.save')}
      </Button>
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
  const [requirePhoto, setRequirePhoto] = useState(initial.requirePhoto);
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

  const radiusNum = Number(radius);
  const graceNum = Number(grace);
  const radiusOk = Number.isInteger(radiusNum) && radiusNum >= 20 && radiusNum <= 5000;
  const graceOk = Number.isInteger(graceNum) && graceNum >= 0 && graceNum <= 120;
  const overtimeNum = Number(overtimeAfter);
  const overtimeOk = Number.isInteger(overtimeNum) && overtimeNum >= 5 && overtimeNum <= 240;
  const canSave = graceOk && overtimeOk && (!requireGeo || (geo !== null && radiusOk));

  const takeCurrentLocation = async () => {
    setLocating(true);
    try {
      const fix = await currentLocation();
      setGeo({ lat: fix.lat, lng: fix.lng, radiusM: radiusOk ? radiusNum : 100 });
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
        <Switch
          label={i18n.t('attendance.settings.requirePhoto')}
          hint={i18n.t('attendance.settings.requirePhotoHint')}
          checked={requirePhoto}
          onChange={(e) => setRequirePhoto(e.target.checked)}
        />
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
            <Field
              label={i18n.t('attendance.settings.radius')}
              hint={i18n.t('attendance.settings.radiusHint')}
            >
              <Input
                inputMode="numeric"
                value={radius}
                invalid={!radiusOk}
                onChange={(e) => {
                  setRadius(e.target.value);
                  const n = Number(e.target.value);
                  if (geo && Number.isInteger(n)) setGeo({ ...geo, radiusM: n });
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
        onClick={() =>
          save.mutate({
            storeId,
            requireDevice,
            requireGeo,
            requirePhoto,
            geo: geo && radiusOk ? { ...geo, radiusM: radiusNum } : null,
            graceMinutes: graceNum,
            overtimeAfterMinutes: overtimeNum,
          })
        }
      >
        {i18n.t('common.save')}
      </Button>
    </section>
  );
}
