/**
 * Manager views of attendance (2026-11-05): one day's sheet (who came,
 * when, late / early / absent, corrections) and the week's shift roster.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
  Sheet,
  Textarea,
  useToast,
} from '@compass/ui';
import { locationVerdict } from '@compass/contracts/limits';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { useErrToast } from '../../lib/errToast';
import type { AttendanceSheetData } from '@compass/api/src/trpc/routers/attendance';
import { minutesText, punchKindText } from '../../lib/attendanceFormat';
import { currencyOf, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import { GeoMap } from '../../components/geo/GeoMap';
import { trpc } from '../../lib/trpc';
import { orgToday } from '../../lib/calendarDate';

type SheetData = AttendanceSheetData;
type Member = SheetData['members'][number];
type Punch = SheetData['punches'][number];
type Shift = SheetData['shifts'][number];
type Day = SheetData['days'][number];

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday of the week holding `date`. */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

const FLAG_TONE: Record<string, 'success' | 'warn' | 'danger' | 'info' | 'muted'> = {
  onDuty: 'success',
  upcoming: 'muted',
  late: 'warn',
  early: 'warn',
  absent: 'danger',
  missedShift: 'danger',
  missingIn: 'danger',
  missingOut: 'danger',
  unscheduled: 'info',
};

function FlagBadges({ day }: { day: Day | undefined }) {
  const i18n = useI18n();
  if (!day || day.flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {day.flags.map((f) => (
        <Badge key={f} tone={FLAG_TONE[f] ?? 'info'}>
          {f === 'late'
            ? i18n.t('attendance.flag.lateBy', { m: day.lateMinutes })
            : f === 'early'
              ? i18n.t('attendance.flag.earlyBy', { m: day.earlyMinutes })
              : i18n.t(`attendance.flag.${f as Exclude<typeof f, 'late' | 'early'>}`)}
        </Badge>
      ))}
    </span>
  );
}

function DateStepper({
  label,
  onPrev,
  onNext,
  onToday,
  showToday,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  showToday: boolean;
}) {
  const i18n = useI18n();
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <Button
        variant="utility"
        size="sm"
        onClick={onPrev}
        aria-label={i18n.t('attendance.nav.prev')}
      >
        ‹
      </Button>
      <span className="min-w-0 flex-1 truncate text-center text-old-h3 font-semibold text-[var(--c-fg)]">
        {label}
      </span>
      <Button
        variant="utility"
        size="sm"
        onClick={onNext}
        aria-label={i18n.t('attendance.nav.next')}
      >
        ›
      </Button>
      {showToday ? (
        <Button variant="ghost" size="sm" onClick={onToday}>
          {i18n.t('attendance.nav.today')}
        </Button>
      ) : null}
    </div>
  );
}

/** The day's pay: owed amount, or why there is none yet. */
function PayLine({ day }: { day: Day | undefined }) {
  const i18n = useI18n();
  const currency = useAuthStore((st) => currencyOf(st.session));
  if (!day) return null;
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const p = day.pay;
  const text =
    p.status === 'payable'
      ? p.deductionCents > 0
        ? i18n.t('attendance.pay.owedDeducted', {
            net: money(p.netCents!),
            deduction: money(p.deductionCents),
          })
        : i18n.t('attendance.pay.owed', { net: money(p.netCents!) })
      : p.status === 'inProgress'
        ? null
        : i18n.t(`attendance.pay.${p.status}`);
  if (!text) return null;
  return <span className="text-old-label text-[var(--c-fg-muted)]">{text}</span>;
}

const OVERTIME_TONE = { pending: 'warn', approved: 'success', rejected: 'muted' } as const;

function OvertimeBadges({ items }: { items: SheetData['overtime'] }) {
  const i18n = useI18n();
  if (items.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((o) => (
        <Badge key={o.id} tone={OVERTIME_TONE[o.status]}>
          {i18n.t(`attendance.overtime.badge.${o.status}`, {
            duration: minutesText(i18n, o.minutes),
          })}
        </Badge>
      ))}
    </span>
  );
}

export const FACE_TONE = {
  match: 'success',
  mismatch: 'danger',
  enrolled: 'info',
  unchecked: 'warn',
} as const;

/**
 * The day's punch checks at a glance: face (2026-11-05), and liveness,
 * borrowed phone and new phone (2026-11-06).
 */
function FaceBadges({ punches }: { punches: SheetData['punches'] }) {
  const i18n = useI18n();
  const live = punches.filter((p) => !p.voided);
  const results = [...new Set(live.filter((p) => p.face).map((p) => p.face!.result))];
  const livenessFailed = live.some((p) => p.liveness === 'fail');
  const borrowed = live.some((p) => p.viaName);
  const newDevice = live.some((p) => p.newDevice);
  const like = [...new Set(live.map((p) => p.faceLikeName).filter((x): x is string => !!x))];
  if (results.length === 0 && !livenessFailed && !borrowed && !newDevice) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {results.map((r) => (
        <Badge key={r} tone={FACE_TONE[r]}>
          {i18n.t(`attendance.face.${r}`)}
        </Badge>
      ))}
      {livenessFailed ? <Badge tone="danger">{i18n.t('attendance.live.badge.fail')}</Badge> : null}
      {borrowed ? <Badge tone="warn">{i18n.t('attendance.borrow.badge')}</Badge> : null}
      {newDevice ? <Badge tone="warn">{i18n.t('attendance.device.newBadge')}</Badge> : null}
      {like.map((name) => (
        <Badge key={`like-${name}`} tone="danger">
          {i18n.t('attendance.face.like', { name })}
        </Badge>
      ))}
    </span>
  );
}

export const LIVE_TONE = {
  pass: 'success',
  passive: 'success',
  fail: 'danger',
  unchecked: 'warn',
} as const;

// ─── Daily sheet ──────────────────────────────────────────────────────────

export function AttendanceSheet({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  // COREWEB2-21: the org's today until the server answers with the
  // store's; it was the phone's.
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [date, setDate] = useState(() => orgToday(orgTimeZone));
  const sheet = trpc.attendance.sheet.useQuery({ storeId, from: date, to: date });
  const today = sheet.data?.today ?? orgToday(orgTimeZone);
  const [openMember, setOpenMember] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <DateStepper
        label={dates.weekdayLong(date)}
        onPrev={() => setDate(addDays(date, -1))}
        onNext={() => setDate(addDays(date, 1))}
        onToday={() => setDate(today)}
        showToday={date !== today}
      />
      <DataState query={sheet}>
        {(data) => {
          const rows = data.members.filter(
            (m) =>
              m.enabled ||
              data.shifts.some((x) => x.memberId === m.memberId) ||
              data.punches.some((p) => p.memberId === m.memberId && p.day === date),
          );
          if (rows.length === 0) {
            return (
              <div className="px-4">
                <EmptyState
                  title={i18n.t('attendance.sheet.emptyTitle')}
                  description={i18n.t('attendance.sheet.emptyBody')}
                />
              </div>
            );
          }
          const counts = { late: 0, absent: 0, onDuty: 0 };
          for (const d of data.days) {
            if (d.flags.includes('late')) counts.late++;
            if (d.flags.includes('absent')) counts.absent++;
            if (d.flags.includes('onDuty')) counts.onDuty++;
          }
          return (
            <>
              <p className="px-4 pb-2 text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('attendance.sheet.summary', counts)}
              </p>
              <ul className="mx-4 flex flex-col gap-2" aria-label={i18n.t('attendance.view.sheet')}>
                {rows.map((m) => (
                  <MemberDayRow
                    key={m.memberId}
                    member={m}
                    date={date}
                    data={data}
                    onOpen={() => setOpenMember(m.memberId)}
                  />
                ))}
              </ul>
              <MemberDaySheet
                storeId={storeId}
                date={date}
                data={data}
                memberId={openMember}
                onClose={() => setOpenMember(null)}
              />
            </>
          );
        }}
      </DataState>
    </div>
  );
}

function MemberDayRow({
  member,
  date,
  data,
  onOpen,
}: {
  member: Member;
  date: string;
  data: SheetData;
  onOpen: () => void;
}) {
  const i18n = useI18n();
  const day = data.days.find((d) => d.memberId === member.memberId && d.date === date);
  const shifts = data.shifts.filter((x) => x.memberId === member.memberId && x.date === date);
  // By the day each counts for: an overnight shift's clock-out is on the
  // shift's row, not also on the next day's.
  const punches = data.punches.filter(
    (p) => p.memberId === member.memberId && !p.voided && p.day === date,
  );
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="press flex w-full flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 text-left ring-hairline"
      >
        <span className="flex w-full items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-old-h3 font-semibold text-[var(--c-fg)]">
            {member.name}
          </span>
          {day && day.workedMinutes > 0 ? (
            <span className="shrink-0 tabular-nums text-old-body-sm text-[var(--c-fg-muted)]">
              {minutesText(i18n, day.workedMinutes)}
            </span>
          ) : null}
        </span>
        {/* With punches but no shift, the "No shift planned" badge says it. */}
        {shifts.length > 0 || punches.length === 0 ? (
          <span className="text-old-label text-[var(--c-fg-muted)]">
            {shifts.length > 0
              ? i18n.t('attendance.sheet.planned', {
                  times: shifts.map((x) => `${x.start}–${x.end}`).join(', '),
                })
              : i18n.t('attendance.sheet.noShift')}
          </span>
        ) : null}
        {punches.length > 0 ? (
          <span className="flex flex-wrap gap-x-3 text-old-body-sm tabular-nums text-[var(--c-fg)]">
            {punches.map((p) => (
              <span key={p.id}>
                {i18n.t(p.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out')} {p.time}
                {p.source === 'manual' ? '*' : ''}
              </span>
            ))}
          </span>
        ) : null}
        <FlagBadges day={day} />
        <FaceBadges punches={punches} />
        <OvertimeBadges
          items={data.overtime.filter((o) => o.memberId === member.memberId && o.date === date)}
        />
        <PayLine day={day} />
      </button>
    </li>
  );
}

/** A punch's face and surroundings photos, loaded when asked for. */
export function PunchPhotoStrip({ storeId, punchId }: { storeId: string; punchId: string }) {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const photos = trpc.attendance.punchPhotos.useQuery(
    { storeId, punchId },
    { enabled: open, staleTime: Infinity },
  );
  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="self-start" onClick={() => setOpen(true)}>
        {i18n.t('attendance.photo.show')}
      </Button>
    );
  }
  return (
    <DataState query={photos}>
      {(list) => (
        <div className="grid grid-cols-2 gap-2">
          {list.map((ph) => (
            <figure key={ph.kind} className="flex flex-col gap-1">
              <img
                src={ph.src}
                alt={i18n.t(`attendance.photo.${ph.kind}`)}
                className="aspect-[3/4] w-full rounded-[var(--r-utility)] object-cover"
              />
              <figcaption className="text-old-label text-[var(--c-fg-muted)]">
                {i18n.t(`attendance.photo.${ph.kind}`)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </DataState>
  );
}

function MemberDaySheet({
  storeId,
  date,
  data,
  memberId,
  onClose,
}: {
  storeId: string;
  date: string;
  data: SheetData;
  memberId: string | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const member = data.members.find((m) => m.memberId === memberId);
  const day = data.days.find((d) => d.memberId === memberId && d.date === date);
  const punches = data.punches.filter((p) => p.memberId === memberId && p.day === date);
  const [kind, setKind] = useState<'in' | 'out'>('in');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [voiding, setVoiding] = useState<Punch | null>(null);
  const [voidReason, setVoidReason] = useState('');
  // The sheet stays mounted from one person to the next: start clean for
  // each, or a void begun on one person's punch would be confirmed on
  // the next person's sheet (review 2026-11-07).
  useEffect(() => {
    setVoiding(null);
    setVoidReason('');
    setKind('in');
    setTime('');
    setReason('');
  }, [memberId, date]);
  // A manager's own row: only a super admin changes it (2026-11-07).
  const own = member?.own ?? false;

  const refresh = () => void utils.attendance.sheet.invalidate();
  const manual = trpc.attendance.manualPunch.useMutation({
    onSuccess: () => {
      haptic('success');
      toast.success(i18n.t('attendance.manual.saved'));
      setTime('');
      setReason('');
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const decide = trpc.attendance.overtimeDecide.useMutation({
    onSuccess: () => {
      haptic('success');
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const overtime = data.overtime.filter((o) => o.memberId === memberId && o.date === date);
  const voidPunch = trpc.attendance.voidPunch.useMutation({
    onSuccess: () => {
      haptic('success');
      setVoiding(null);
      setVoidReason('');
      refresh();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });

  return (
    <Sheet
      open={memberId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={member?.name ?? ''}
      description={i18n.t('attendance.sheet.memberDayHint')}
    >
      <div className="flex flex-col gap-3 py-3">
        <FlagBadges day={day} />
        <PunchMap data={data} punches={punches} />
        {punches.length === 0 ? (
          <p className="text-old-body text-[var(--c-fg-muted)]">
            {i18n.t('attendance.sheet.noPunches')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {punches.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-2 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={
                      p.voided ? 'text-[var(--c-fg-subtle)] line-through' : 'text-[var(--c-fg)]'
                    }
                  >
                    <span className="tabular-nums font-semibold">{p.time}</span>{' '}
                    {punchKindText(i18n, dates, p, date)}
                    <span className="block text-old-label text-[var(--c-fg-muted)] no-underline">
                      {p.source === 'manual'
                        ? i18n.t('attendance.sheet.manualBy', {
                            name: p.createdByName ?? '—',
                            reason: p.reason ?? '',
                          })
                        : p.distanceM !== null
                          ? i18n.t('attendance.sheet.selfAt', { m: p.distanceM })
                          : i18n.t('attendance.source.self')}
                      {p.voided
                        ? ` · ${i18n.t('attendance.sheet.voidedBy', {
                            name: p.voided.byName ?? '—',
                            // "Not them" on a colleague's phone is stored as a key (2026-11-07).
                            reason:
                              p.voided.reason === 'attendance.voidReason.wrongPerson'
                                ? i18n.t('attendance.voidReason.wrongPerson')
                                : p.voided.reason,
                          })}`
                        : ''}
                    </span>
                  </span>
                  {!p.voided && !own ? (
                    <Button variant="ghost" size="sm" onClick={() => setVoiding(p)}>
                      {i18n.t('attendance.void.action')}
                    </Button>
                  ) : null}
                </div>
                {p.face || p.liveness || p.viaName || p.newDevice ? (
                  <span className="flex flex-wrap items-center gap-2 text-old-label text-[var(--c-fg-muted)]">
                    {p.face ? (
                      <>
                        <Badge tone={FACE_TONE[p.face.result]}>
                          {i18n.t(`attendance.face.${p.face.result}`)}
                        </Badge>
                        {p.face.score !== null
                          ? i18n.t('attendance.face.score', {
                              score: Math.round(p.face.score * 100),
                            })
                          : null}
                      </>
                    ) : null}
                    {p.liveness ? (
                      <Badge tone={LIVE_TONE[p.liveness]}>
                        {i18n.t(`attendance.live.badge.${p.liveness}`)}
                      </Badge>
                    ) : null}
                    {p.newDevice ? (
                      <Badge tone="warn">{i18n.t('attendance.device.newBadge')}</Badge>
                    ) : null}
                    {p.faceLikeName ? (
                      <Badge tone="danger">
                        {i18n.t('attendance.face.like', { name: p.faceLikeName })}
                      </Badge>
                    ) : null}
                    {p.viaName ? (
                      <span className="basis-full">
                        {i18n.t('attendance.borrow.via', { name: p.viaName })}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {p.photos.length > 0 ? <PunchPhotoStrip storeId={storeId} punchId={p.id} /> : null}
              </li>
            ))}
          </ul>
        )}

        <PayLine day={day} />
        {overtime.map((o) => (
          <div key={o.id} className="flex flex-col gap-2 rounded-[var(--r-card)] p-3 ring-hairline">
            <span className="text-old-body font-semibold text-[var(--c-fg)]">
              {i18n.t(`attendance.overtime.badge.${o.status}`, {
                duration: minutesText(i18n, o.minutes),
              })}
            </span>
            <span className="text-old-label text-[var(--c-fg-muted)]">
              {o.reason
                ? i18n.t('attendance.overtime.reasonLine', { reason: o.reason })
                : i18n.t('attendance.overtime.noReason')}
              {o.decidedByName
                ? ` · ${i18n.t('attendance.overtime.decidedBy', { name: o.decidedByName })}`
                : ''}
              {o.decisionNote ? ` · ${o.decisionNote}` : ''}
            </span>
            {o.status === 'pending' && !own ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={
                    decide.isPending &&
                    decide.variables?.overtimeId === o.id &&
                    !decide.variables.approve
                  }
                  onClick={() => decide.mutate({ storeId, overtimeId: o.id, approve: false })}
                >
                  {i18n.t('attendance.overtime.reject')}
                </Button>
                <Button
                  size="sm"
                  loading={
                    decide.isPending &&
                    decide.variables?.overtimeId === o.id &&
                    decide.variables.approve
                  }
                  onClick={() => decide.mutate({ storeId, overtimeId: o.id, approve: true })}
                >
                  {i18n.t('attendance.overtime.approve')}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {voiding && punches.some((p) => p.id === voiding.id) ? (
          <div className="flex flex-col gap-2 rounded-[var(--r-card)] p-3 ring-hairline">
            <Field label={i18n.t('attendance.void.reasonLabel', { time: voiding.time })}>
              <Input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
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
                disabled={voidReason.trim().length === 0}
                loading={voidPunch.isPending}
                onClick={() =>
                  voidPunch.mutate({ storeId, punchId: voiding.id, reason: voidReason.trim() })
                }
              >
                {i18n.t('attendance.void.confirm')}
              </Button>
            </div>
          </div>
        ) : null}

        {own ? (
          <p className="text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('attendance.sheet.ownHint')}
          </p>
        ) : (
          <ManualPunchForm
            kind={kind}
            setKind={setKind}
            time={time}
            setTime={setTime}
            reason={reason}
            setReason={setReason}
            saving={manual.isPending}
            onSave={() =>
              memberId &&
              manual.mutate({ storeId, memberId, kind, date, time, reason: reason.trim() })
            }
          />
        )}
      </div>
    </Sheet>
  );
}

/** A punch a manager adds, with the reason. */
function ManualPunchForm(props: {
  kind: 'in' | 'out';
  setKind: (k: 'in' | 'out') => void;
  time: string;
  setTime: (t: string) => void;
  reason: string;
  setReason: (r: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const i18n = useI18n();
  const { kind, setKind, time, setTime, reason, setReason } = props;
  return (
    <>
      <h3 className="mt-2 text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.manual.title')}
      </h3>
      <Segmented<'in' | 'out'>
        value={kind}
        onChange={setKind}
        ariaLabel={i18n.t('attendance.manual.title')}
        options={[
          { value: 'in', label: i18n.t('attendance.kind.in') },
          { value: 'out', label: i18n.t('attendance.kind.out') },
        ]}
      />
      <Field label={i18n.t('attendance.manual.time')}>
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </Field>
      <Field label={i18n.t('attendance.manual.reason')}>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder={i18n.t('attendance.manual.reasonPlaceholder')}
        />
      </Field>
      <Button
        block
        disabled={!/^\d{2}:\d{2}$/.test(time) || reason.trim().length === 0}
        loading={props.saving}
        onClick={props.onSave}
      >
        {i18n.t('attendance.manual.save')}
      </Button>
    </>
  );
}

// ─── Weekly roster ────────────────────────────────────────────────────────

type ShiftDraft = {
  shiftId?: string;
  memberId: string;
  date: string;
  start: string;
  end: string;
  note: string;
};

export function AttendanceRoster({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [monday, setMonday] = useState(() => mondayOf(orgToday(orgTimeZone)));
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const sheet = trpc.attendance.sheet.useQuery({ storeId, from: monday, to: week[6]! });
  const [draft, setDraft] = useState<ShiftDraft | null>(null);
  const copyWeek = trpc.attendance.copyWeek.useMutation({
    onSuccess: (r) => {
      haptic('success');
      toast.success(i18n.t('attendance.roster.copied', { copied: r.copied, skipped: r.skipped }));
      void utils.attendance.sheet.invalidate();
    },
    onError: errToast('attendance.errors.saveFailed'),
  });
  const thisMonday = mondayOf(sheet.data?.today ?? orgToday(orgTimeZone));

  return (
    <div className="flex flex-col">
      <DateStepper
        label={i18n.t('attendance.roster.weekOf', {
          from: dates.calendarDay(monday),
          to: dates.calendarDay(week[6]!),
        })}
        onPrev={() => setMonday(addDays(monday, -7))}
        onNext={() => setMonday(addDays(monday, 7))}
        onToday={() => setMonday(thisMonday)}
        showToday={monday !== thisMonday}
      />
      <DataState query={sheet}>
        {(data) => {
          const people = data.members.filter((m) => m.inStore);
          const name = (id: string) => data.members.find((m) => m.memberId === id)?.name ?? '—';
          const newDraft = (date: string): ShiftDraft => {
            // Start from the last shift planned on that weekday, else 09:00–18:00.
            const last = [...data.shifts].reverse()[0] as Shift | undefined;
            return {
              memberId: people[0]?.memberId ?? '',
              date,
              start: last?.start ?? '09:00',
              end: last?.end ?? '18:00',
              note: '',
            };
          };
          return (
            <>
              <div className="flex flex-col gap-2 px-4">
                {week.map((date) => {
                  const shifts = data.shifts.filter((x) => x.date === date);
                  return (
                    <section
                      key={date}
                      className="rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3
                          className={
                            'text-old-h3 font-semibold ' +
                            (date === data.today ? 'text-[var(--c-action)]' : 'text-[var(--c-fg)]')
                          }
                        >
                          {dates.weekdayLong(date)}
                        </h3>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={people.length === 0}
                          onClick={() => setDraft(newDraft(date))}
                        >
                          {i18n.t('attendance.roster.add')}
                        </Button>
                      </div>
                      {shifts.length === 0 ? (
                        <p className="text-old-label text-[var(--c-fg-subtle)]">
                          {i18n.t('attendance.roster.none')}
                        </p>
                      ) : (
                        <ul className="mt-1 flex flex-col">
                          {shifts.map((x) => (
                            <li key={x.id}>
                              <button
                                type="button"
                                className="press flex w-full items-center justify-between gap-2 py-1.5 text-left"
                                onClick={() =>
                                  setDraft({
                                    shiftId: x.id,
                                    memberId: x.memberId,
                                    date: x.date,
                                    start: x.start,
                                    end: x.end,
                                    note: x.note ?? '',
                                  })
                                }
                              >
                                <span className="min-w-0 truncate text-old-body text-[var(--c-fg)]">
                                  {name(x.memberId)}
                                  {x.note ? (
                                    <span className="text-old-label text-[var(--c-fg-muted)]">
                                      {' '}
                                      · {x.note}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="shrink-0 tabular-nums text-old-body text-[var(--c-fg-muted)]">
                                  {x.start}–{x.end}
                                  {x.end <= x.start
                                    ? ` ${i18n.t('attendance.roster.nextDay')}`
                                    : ''}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
              {people.length === 0 ? (
                <p className="px-4 pt-3 text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('attendance.roster.noPeople')}
                </p>
              ) : null}
              <div className="px-4 pt-3">
                <Button
                  variant="secondary"
                  block
                  loading={copyWeek.isPending}
                  onClick={() =>
                    copyWeek.mutate({ storeId, fromWeek: addDays(monday, -7), toWeek: monday })
                  }
                >
                  {i18n.t('attendance.roster.copyLastWeek')}
                </Button>
              </div>
              <ShiftSheet
                storeId={storeId}
                draft={draft}
                members={people}
                onClose={() => setDraft(null)}
              />
            </>
          );
        }}
      </DataState>
    </div>
  );
}

function ShiftSheet({
  storeId,
  draft,
  members,
  onClose,
}: {
  storeId: string;
  draft: ShiftDraft | null;
  members: Member[];
  onClose: () => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [form, setForm] = useState<ShiftDraft | null>(draft);
  const [seen, setSeen] = useState<ShiftDraft | null>(draft);
  if (draft !== seen) {
    setSeen(draft);
    setForm(draft);
  }
  const done = () => {
    haptic('success');
    void utils.attendance.sheet.invalidate();
    onClose();
  };
  const save = trpc.attendance.shiftSave.useMutation({
    onSuccess: done,
    onError: errToast('attendance.errors.saveFailed'),
  });
  const del = trpc.attendance.shiftDelete.useMutation({
    onSuccess: done,
    onError: errToast('attendance.errors.saveFailed'),
  });
  const valid =
    !!form &&
    !!form.memberId &&
    /^\d{2}:\d{2}$/.test(form.start) &&
    /^\d{2}:\d{2}$/.test(form.end) &&
    form.start !== form.end;

  return (
    <Sheet
      open={draft !== null}
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t(draft?.shiftId ? 'attendance.shift.editTitle' : 'attendance.shift.addTitle')}
      description={draft ? dates.weekdayLong(draft.date) : ''}
    >
      {form ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label={i18n.t('attendance.shift.person')}>
            <Select
              value={form.memberId}
              onChange={(e) => setForm({ ...form, memberId: e.target.value })}
            >
              {members.map((m) => (
                <option key={m.memberId} value={m.memberId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={i18n.t('attendance.shift.start')}>
              <Input
                type="time"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </Field>
            <Field label={i18n.t('attendance.shift.end')}>
              <Input
                type="time"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </Field>
          </div>
          {valid && form.end < form.start ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('attendance.shift.overnightHint')}
            </p>
          ) : null}
          <Field label={i18n.t('attendance.shift.note')}>
            <Input
              value={form.note}
              maxLength={200}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder={i18n.t('attendance.shift.notePlaceholder')}
            />
          </Field>
          <Button
            block
            disabled={!valid}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                storeId,
                shiftId: form.shiftId,
                memberId: form.memberId,
                date: form.date,
                start: form.start,
                end: form.end,
                note: form.note.trim() || undefined,
              })
            }
          >
            {i18n.t('common.save')}
          </Button>
          {form.shiftId ? (
            <Button
              variant="danger"
              block
              loading={del.isPending}
              onClick={() => del.mutate({ storeId, shiftId: form.shiftId! })}
            >
              {i18n.t('attendance.shift.delete')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Where the day's punches were, on a map with the store's area
 * (2026-11-07): green inside, red outside, the faint circle the phone's
 * accuracy. Inside is the punch's own rule (locationVerdict, review
 * ATT-08); an accuracy the phone did not send counts as none. Only
 * punches that carried a location.
 */
function PunchMap({ data, punches }: { data: SheetData; punches: readonly Punch[] }) {
  const i18n = useI18n();
  const placed = punches.filter((p) => p.location && !p.voided);
  if (placed.length === 0) return null;
  const area = data.geo;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-old-label font-semibold text-[var(--c-fg-muted)]">
        {i18n.t('attendance.map.punches')}
      </h3>
      <GeoMap
        area={area}
        points={placed.map((p) => {
          const outside =
            area !== null &&
            p.distanceM !== null &&
            locationVerdict({
              distanceM: p.distanceM,
              accuracyM: p.location!.accuracyM ?? 0,
              radiusM: area.radiusM,
            }) !== 'inside';
          return {
            lat: p.location!.lat,
            lng: p.location!.lng,
            accuracyM: p.location!.accuracyM,
            tone: outside ? ('outside' as const) : ('inside' as const),
            label: `${p.time} ${i18n.t(p.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out')}`,
          };
        })}
        label={i18n.t('attendance.map.punches')}
      />
    </section>
  );
}
