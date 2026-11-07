/**
 * Attendance rules (2026-11-05). Pure: callers pass the clock.
 *
 * A shift is planned in the store's local time ("2026-11-05", "09:00" →
 * "21:00"); an end at or before the start means the next day. Punches are
 * instants. `summarize` assigns each punch to the shift it belongs to
 * and judges late / early / absent / missing punches against it.
 */

const MINUTE = 60_000;

/** Offset of `tz` from UTC at `at`, in minutes (Asia/Tashkent → +300). */
function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / MINUTE);
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` + `HH:MM` wall-clock time in `tz` → the instant. */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new Error(`bad local time ${date} ${time}`);
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Two passes settle the offset across a DST change.
  let at = guess - offsetMinutes(tz, new Date(guess)) * MINUTE;
  at = guess - offsetMinutes(tz, new Date(at)) * MINUTE;
  return new Date(at);
}

/** `HH:MM` of an instant in `tz`. */
export function localTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/** The local date one day after `date` (`YYYY-MM-DD`). */
export function nextDate(date: string, days = 1): string {
  const d = DATE_RE.exec(date);
  if (!d) throw new Error(`bad date ${date}`);
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days));
  return at.toISOString().slice(0, 10);
}

/** A planned shift's instants; an end at or before the start ends next day. */
export function shiftWindow(
  date: string,
  start: string,
  end: string,
  tz: string,
): { startsAt: Date; endsAt: Date } {
  const startsAt = zonedTimeToUtc(date, start, tz);
  const endDate = end <= start ? nextDate(date) : date;
  return { startsAt, endsAt: zonedTimeToUtc(endDate, end, tz) };
}

/** Great-circle distance in metres. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ShiftInput {
  id: string;
  memberId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
}

export interface PunchInput {
  id: string;
  memberId: string;
  kind: 'in' | 'out';
  at: Date;
}

export type DayFlag =
  /** The shift has not started yet. */
  | 'upcoming'
  /** Clocked in, shift still running. */
  | 'onDuty'
  | 'late'
  | 'early'
  /** The day's started shifts had no punch at all (past grace). */
  | 'absent'
  /**
   * One of the day's shifts had no punch while another was worked
   * (2026-11-07): its minutes are short, not the whole day.
   */
  | 'missedShift'
  /** An out with no in before it. */
  | 'missingIn'
  /** An in with no out after the shift ended. */
  | 'missingOut'
  /** Punches on a day with no planned shift. */
  | 'unscheduled';

export interface DaySummary {
  memberId: string;
  date: string;
  shiftIds: string[];
  /** Planned minutes over the day's shifts. */
  plannedMinutes: number;
  punchIds: string[];
  /** Minutes between paired in → out punches. */
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  /** Planned minutes of shifts with no punch at all (past grace). */
  missedMinutes: number;
  flags: DayFlag[];
}

/** How far outside its window a punch still counts toward a shift. */
const BEFORE_START = 4 * 60 * MINUTE;
const AFTER_END = 6 * 60 * MINUTE;

function pairWorked(punches: readonly PunchInput[]): {
  minutes: number;
  missingIn: boolean;
  openSince: Date | null;
} {
  let minutes = 0;
  let missingIn = false;
  let openSince: Date | null = null;
  for (const p of punches) {
    if (p.kind === 'in') {
      // A second in without an out: keep the first.
      if (!openSince) openSince = p.at;
    } else if (openSince) {
      minutes += Math.max(0, Math.round((p.at.getTime() - openSince.getTime()) / MINUTE));
      openSince = null;
    } else {
      missingIn = true;
    }
  }
  return { minutes, missingIn, openSince };
}

/**
 * One row per member and day that has a shift or a punch. `dateOf` maps
 * an unscheduled punch to its local date (the caller knows the zone).
 */
export function summarize(input: {
  shifts: readonly ShiftInput[];
  punches: readonly PunchInput[];
  graceMinutes: number;
  now: Date;
  dateOf: (at: Date) => string;
}): DaySummary[] {
  const grace = input.graceMinutes * MINUTE;
  const now = input.now.getTime();
  const byShift = new Map<string, PunchInput[]>();
  const loose = new Map<string, PunchInput[]>();
  const sortedShifts = [...input.shifts].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  for (const p of [...input.punches].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const t = p.at.getTime();
    let best: ShiftInput | null = null;
    let bestGap = Infinity;
    for (const s of sortedShifts) {
      if (s.memberId !== p.memberId) continue;
      const from = s.startsAt.getTime() - BEFORE_START;
      const to = s.endsAt.getTime() + AFTER_END;
      if (t < from || t > to) continue;
      const gap =
        t < s.startsAt.getTime()
          ? s.startsAt.getTime() - t
          : t > s.endsAt.getTime()
            ? t - s.endsAt.getTime()
            : 0;
      if (gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    if (best) {
      const list = byShift.get(best.id) ?? [];
      list.push(p);
      byShift.set(best.id, list);
    } else {
      const key = `${p.memberId}|${input.dateOf(p.at)}`;
      const list = loose.get(key) ?? [];
      list.push(p);
      loose.set(key, list);
    }
  }

  const rows = new Map<string, DaySummary>();
  const row = (memberId: string, date: string): DaySummary => {
    const key = `${memberId}|${date}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        memberId,
        date,
        shiftIds: [],
        plannedMinutes: 0,
        punchIds: [],
        workedMinutes: 0,
        lateMinutes: 0,
        earlyMinutes: 0,
        missedMinutes: 0,
        flags: [],
      };
      rows.set(key, r);
    }
    return r;
  };
  const flag = (r: DaySummary, f: DayFlag) => {
    if (!r.flags.includes(f)) r.flags.push(f);
  };

  for (const s of sortedShifts) {
    const r = row(s.memberId, s.date);
    const start = s.startsAt.getTime();
    const end = s.endsAt.getTime();
    r.shiftIds.push(s.id);
    r.plannedMinutes += Math.round((end - start) / MINUTE);
    const ps = byShift.get(s.id) ?? [];
    r.punchIds.push(...ps.map((p) => p.id));
    const worked = pairWorked(ps);
    r.workedMinutes += worked.minutes;
    if (worked.missingIn) flag(r, 'missingIn');

    if (ps.length === 0) {
      if (now < start + grace) flag(r, 'upcoming');
      else r.missedMinutes += Math.round((end - start) / MINUTE);
      continue;
    }
    const firstIn = ps.find((p) => p.kind === 'in');
    if (firstIn && firstIn.at.getTime() > start + grace) {
      r.lateMinutes += Math.round((firstIn.at.getTime() - start) / MINUTE);
      flag(r, 'late');
    }
    if (worked.openSince) {
      if (now <= end) {
        flag(r, 'onDuty');
        r.workedMinutes += Math.max(0, Math.round((now - worked.openSince.getTime()) / MINUTE));
      } else flag(r, 'missingOut');
    }
    const outs = ps.filter((p) => p.kind === 'out');
    const lastOut = outs[outs.length - 1];
    if (lastOut && !worked.openSince && lastOut.at.getTime() < end - grace) {
      r.earlyMinutes += Math.round((end - lastOut.at.getTime()) / MINUTE);
      flag(r, 'early');
    }
  }

  for (const [key, ps] of loose) {
    const [memberId, date] = key.split('|') as [string, string];
    const r = row(memberId, date);
    r.punchIds.push(...ps.map((p) => p.id));
    const worked = pairWorked(ps);
    r.workedMinutes += worked.minutes;
    flag(r, 'unscheduled');
    if (worked.missingIn) flag(r, 'missingIn');
    if (worked.openSince) {
      if (date === input.dateOf(input.now)) {
        flag(r, 'onDuty');
        r.workedMinutes += Math.max(0, Math.round((now - worked.openSince.getTime()) / MINUTE));
      } else flag(r, 'missingOut');
    }
  }

  // A missed shift: the whole day when nothing at all was punched, else
  // only that shift's minutes (split shifts, 2026-11-07).
  for (const r of rows.values()) {
    if (r.missedMinutes > 0) flag(r, r.punchIds.length === 0 ? 'absent' : 'missedShift');
  }

  return [...rows.values()].sort((a, b) =>
    a.date === b.date ? a.memberId.localeCompare(b.memberId) : a.date.localeCompare(b.date),
  );
}

/**
 * Which button the clock screen offers: after an in, out; otherwise in.
 * An in older than `openHours` (a forgotten clock-out) no longer holds
 * the next punch to an out. `punches` are the member's non-voided
 * punches at the store, any order.
 */
export function nextPunchKind(
  punches: readonly { kind: 'in' | 'out'; at: Date }[],
  now: Date,
  openHours = 16,
): 'in' | 'out' {
  let last: { kind: 'in' | 'out'; at: Date } | null = null;
  for (const p of punches) if (!last || p.at.getTime() >= last.at.getTime()) last = p;
  if (last?.kind !== 'in') return 'in';
  return now.getTime() - last.at.getTime() > openHours * 60 * MINUTE ? 'in' : 'out';
}

export type ReminderAction = 'remindIn' | 'tellManagersAbsent' | 'remindOut';

/**
 * Which reminders one shift is due right now. `lastKind` is the member's
 * latest non-voided punch at the store since four hours before the shift
 * began (null: none). Each action fires inside a window so a scan every
 * few minutes sends it once (the sender also dedups per shift), and an
 * old shift never wakes up after a restart.
 */
export function dueReminders(input: {
  startsAt: Date;
  endsAt: Date;
  graceMinutes: number;
  lastKind: 'in' | 'out' | null;
  now: Date;
}): ReminderAction[] {
  const now = input.now.getTime();
  const start = input.startsAt.getTime();
  const end = input.endsAt.getTime();
  const out: ReminderAction[] = [];
  const inWindow = (from: number, to: number) => now >= from && now <= to;
  if (input.lastKind === null) {
    if (
      inWindow(start + (input.graceMinutes + 5) * MINUTE, Math.min(end, start + 3 * 60 * MINUTE))
    ) {
      out.push('remindIn');
    }
    if (inWindow(start + 30 * MINUTE, Math.min(end, start + 3 * 60 * MINUTE))) {
      out.push('tellManagersAbsent');
    }
  }
  if (input.lastKind === 'in' && inWindow(end + 30 * MINUTE, end + 6 * 60 * MINUTE)) {
    out.push('remindOut');
  }
  return out;
}

/**
 * Minutes a clock-out runs past the shift's end, counted only once it is
 * at least `afterMinutes` late (a few minutes of tidying up is not
 * overtime). 0 otherwise.
 */
export function overtimeMinutes(endsAt: Date, outAt: Date, afterMinutes: number): number {
  const past = Math.floor((outAt.getTime() - endsAt.getTime()) / MINUTE);
  return past >= afterMinutes ? past : 0;
}

export type PayStatus =
  /** Worked the planned shift(s); net = wage − deductions. */
  | 'payable'
  /** Planned but never came: no pay. */
  | 'absent'
  /** A missing punch or a day without a shift: a manager fixes it first. */
  | 'needsReview'
  /** The shift is still running or has not started. */
  | 'inProgress'
  /** No daily wage set for that day. */
  | 'noRate';

export interface DayPay {
  status: PayStatus;
  wageCents: number;
  deductionCents: number;
  /** Null unless payable / absent. */
  netCents: number | null;
}

/**
 * One person's pay for one day from its attendance verdict (owner decision
 * 2026-11-05): the daily wage, less late + early minutes in proportion to
 * the planned minutes, rounded half-up to the cent, never below zero.
 * A missed shift on a day otherwise worked counts as short minutes; a day
 * with punches that do not fit the plan is checked by a manager before an
 * absence is assumed (2026-11-07).
 */
export function dayPay(day: DaySummary, wageCents: number | null): DayPay {
  if (wageCents === null)
    return { status: 'noRate', wageCents: 0, deductionCents: 0, netCents: null };
  const has = (f: DayFlag) => day.flags.includes(f);
  if (has('upcoming') || has('onDuty')) {
    return { status: 'inProgress', wageCents, deductionCents: 0, netCents: null };
  }
  if (has('missingIn') || has('missingOut') || has('unscheduled') || day.plannedMinutes <= 0) {
    return { status: 'needsReview', wageCents, deductionCents: 0, netCents: null };
  }
  if (has('absent')) return { status: 'absent', wageCents, deductionCents: 0, netCents: 0 };
  const short = Math.min(
    day.plannedMinutes,
    day.lateMinutes + day.earlyMinutes + day.missedMinutes,
  );
  // Integer half-up: (2·w·m + p) ÷ 2p.
  const deductionCents = Math.min(
    wageCents,
    Math.floor((2 * wageCents * short + day.plannedMinutes) / (2 * day.plannedMinutes)),
  );
  return { status: 'payable', wageCents, deductionCents, netCents: wageCents - deductionCents };
}
