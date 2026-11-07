import { describe, expect, test } from 'bun:test';
import {
  dayPay,
  distanceMeters,
  dueReminders,
  overtimeMinutes,
  localTime,
  nextPunchKind,
  shiftWindow,
  summarize,
  zonedTimeToUtc,
  type PunchInput,
  type ShiftInput,
} from './index';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const dateOf = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

describe('local time', () => {
  test('wall clock in Tashkent → UTC', () => {
    expect(at('2026-11-05', '09:00').toISOString()).toBe('2026-11-05T04:00:00.000Z');
    expect(localTime(at('2026-11-05', '21:30'), TZ)).toBe('21:30');
  });
  test('DST zone resolves on both sides of the change', () => {
    expect(zonedTimeToUtc('2026-07-01', '09:00', 'Europe/Moscow').toISOString()).toBe(
      '2026-07-01T06:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-30', '09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-30T07:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-27', '09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-27T08:00:00.000Z',
    );
  });
  test('an end at or before the start is next day', () => {
    const w = shiftWindow('2026-11-05', '20:00', '04:00', TZ);
    expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(8 * 3600_000);
    expect(() => shiftWindow('2026-11-05', '25:00', '04:00', TZ)).toThrow();
  });
});

test('distance: ~111 m per 0.001° latitude', () => {
  const d = distanceMeters({ lat: 41.3, lng: 69.24 }, { lat: 41.301, lng: 69.24 });
  expect(Math.round(d)).toBe(111);
});

const shift = (id: string, date: string, s: string, e: string, memberId = 'm1'): ShiftInput => ({
  id,
  memberId,
  date,
  ...shiftWindow(date, s, e, TZ),
});
let n = 0;
const punch = (kind: 'in' | 'out', date: string, time: string, memberId = 'm1'): PunchInput => ({
  id: `p${++n}`,
  memberId,
  kind,
  at: at(date, time),
});
const run = (shifts: ShiftInput[], punches: PunchInput[], now: Date) =>
  summarize({ shifts, punches, graceMinutes: 5, now, dateOf });

describe('summarize', () => {
  const D = '2026-11-05';
  test('on time, full shift', () => {
    const [r] = run(
      [shift('s', D, '09:00', '18:00')],
      [punch('in', D, '08:55'), punch('out', D, '18:02')],
      at(D, '20:00'),
    );
    expect(r!.flags).toEqual([]);
    expect(r!.workedMinutes).toBe(547);
    expect(r!.plannedMinutes).toBe(540);
  });
  test('late within grace is not late; after grace counts from start', () => {
    const [ok] = run(
      [shift('s', D, '09:00', '18:00')],
      [punch('in', D, '09:05'), punch('out', D, '18:00')],
      at(D, '20:00'),
    );
    expect(ok!.flags).toEqual([]);
    const [late] = run(
      [shift('s', D, '09:00', '18:00')],
      [punch('in', D, '09:20'), punch('out', D, '18:00')],
      at(D, '20:00'),
    );
    expect(late!.flags).toEqual(['late']);
    expect(late!.lateMinutes).toBe(20);
  });
  test('early leave', () => {
    const [r] = run(
      [shift('s', D, '09:00', '18:00')],
      [punch('in', D, '09:00'), punch('out', D, '17:00')],
      at(D, '20:00'),
    );
    expect(r!.flags).toEqual(['early']);
    expect(r!.earlyMinutes).toBe(60);
  });
  test('upcoming, then absent', () => {
    expect(run([shift('s', D, '09:00', '18:00')], [], at(D, '08:00'))[0]!.flags).toEqual([
      'upcoming',
    ]);
    expect(run([shift('s', D, '09:00', '18:00')], [], at(D, '09:30'))[0]!.flags).toEqual([
      'absent',
    ]);
  });
  test('on duty counts time so far; forgot to clock out', () => {
    const s = [shift('s', D, '09:00', '18:00')];
    const p = [punch('in', D, '09:00')];
    const duty = run(s, p, at(D, '12:00'))[0]!;
    expect(duty.flags).toEqual(['onDuty']);
    expect(duty.workedMinutes).toBe(180);
    const forgot = run(s, p, at(D, '23:00'))[0]!;
    expect(forgot.flags).toEqual(['missingOut']);
    expect(forgot.workedMinutes).toBe(0);
  });
  test('out without in', () => {
    const [r] = run([shift('s', D, '09:00', '18:00')], [punch('out', D, '18:00')], at(D, '20:00'));
    expect(r!.flags).toContain('missingIn');
  });
  test('overnight shift keeps its early-morning out', () => {
    const rows = run(
      [shift('s', D, '20:00', '04:00')],
      [punch('in', D, '19:58'), punch('out', '2026-11-06', '04:01')],
      at('2026-11-06', '09:00'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe(D);
    expect(rows[0]!.workedMinutes).toBe(483);
  });
  test('punches with no shift are unscheduled, per local date', () => {
    const rows = run([], [punch('in', D, '10:00'), punch('out', D, '14:00')], at(D, '20:00'));
    expect(rows[0]!.flags).toEqual(['unscheduled']);
    expect(rows[0]!.workedMinutes).toBe(240);
  });
  test('split shift: each punch goes to the nearer shift', () => {
    const rows = run(
      [shift('a', D, '08:00', '12:00'), shift('b', D, '16:00', '20:00')],
      [
        punch('in', D, '08:00'),
        punch('out', D, '12:00'),
        punch('in', D, '16:30'),
        punch('out', D, '20:00'),
      ],
      at(D, '22:00'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workedMinutes).toBe(480 - 30);
    expect(rows[0]!.flags).toEqual(['late']);
    expect(rows[0]!.lateMinutes).toBe(30);
  });
  test('members are kept apart', () => {
    const rows = run(
      [shift('a', D, '09:00', '18:00', 'm1'), shift('b', D, '09:00', '18:00', 'm2')],
      [punch('in', D, '09:00', 'm1'), punch('out', D, '18:00', 'm1')],
      at(D, '20:00'),
    );
    expect(rows.map((r) => [r.memberId, r.flags])).toEqual([
      ['m1', []],
      ['m2', ['absent']],
    ]);
  });
});

test('next punch kind', () => {
  const now = at('2026-11-05', '12:00');
  expect(nextPunchKind([], now)).toBe('in');
  expect(nextPunchKind([{ kind: 'in', at: at('2026-11-05', '09:00') }], now)).toBe('out');
  expect(
    nextPunchKind(
      [
        { kind: 'out', at: at('2026-11-05', '11:00') },
        { kind: 'in', at: at('2026-11-05', '09:00') },
      ],
      now,
    ),
  ).toBe('in');
  // forgot to clock out yesterday
  expect(nextPunchKind([{ kind: 'in', at: at('2026-11-04', '09:00') }], now)).toBe('in');
});

describe('reminders', () => {
  const D = '2026-11-05';
  const w = shiftWindow(D, '09:00', '18:00', TZ);
  const due = (time: string, lastKind: 'in' | 'out' | null, date = D) =>
    dueReminders({ ...w, graceMinutes: 5, lastKind, now: at(date, time) });
  test('not clocked in: the person after grace + 5 min, managers after 30 min', () => {
    expect(due('09:05', null)).toEqual([]);
    expect(due('09:10', null)).toEqual(['remindIn']);
    expect(due('09:30', null)).toEqual(['remindIn', 'tellManagersAbsent']);
    expect(due('12:01', null)).toEqual([]);
    expect(due('09:30', 'in')).toEqual([]);
  });
  test('forgot to clock out: 30 min to 6 h after the end', () => {
    expect(due('18:10', 'in')).toEqual([]);
    expect(due('18:30', 'in')).toEqual(['remindOut']);
    expect(due('18:30', 'out')).toEqual([]);
    expect(due('00:01', 'in', '2026-11-06')).toEqual([]);
  });
  test('a short shift stops the clock-in reminder at its end', () => {
    const s = shiftWindow(D, '09:00', '09:20', TZ);
    expect(dueReminders({ ...s, graceMinutes: 5, lastKind: null, now: at(D, '09:15') })).toEqual([
      'remindIn',
    ]);
    expect(dueReminders({ ...s, graceMinutes: 5, lastKind: null, now: at(D, '09:25') })).toEqual(
      [],
    );
  });
});

describe('pay', () => {
  const D = '2026-11-05';
  const day = (s0: string, e0: string, punches: PunchInput[], now = at(D, '23:00')) =>
    run([shift('s', D, s0, e0)], punches, now)[0]!;
  test('full day is the daily wage', () => {
    const p = dayPay(
      day('09:00', '18:00', [punch('in', D, '09:00'), punch('out', D, '18:00')]),
      10_000_000,
    );
    expect(p).toEqual({
      status: 'payable',
      wageCents: 10_000_000,
      deductionCents: 0,
      netCents: 10_000_000,
    });
  });
  test('late and early are deducted in proportion, half-up to the cent', () => {
    // 9 h shift = 540 min; 20 late + 7 early = 27 min → 27/540 = 5 %.
    const p = dayPay(
      day('09:00', '18:00', [punch('in', D, '09:20'), punch('out', D, '17:53')]),
      10_000_000,
    );
    expect(p.deductionCents).toBe(500_000);
    expect(p.netCents).toBe(9_500_000);
    // 1 min of 540 on 100.00 → 0.185… → 0.19
    const q = dayPay(
      day('09:00', '18:00', [punch('in', D, '09:06'), punch('out', D, '18:00')]),
      10_000,
    );
    expect(q.deductionCents).toBe(111); // 6 late (grace 5 passed) → 6/540·100.00 = 1.111 → 1.11
  });
  test('absent pays nothing; missing punch waits for the manager; no rate says so', () => {
    expect(dayPay(day('09:00', '18:00', []), 10_000).status).toBe('absent');
    expect(dayPay(day('09:00', '18:00', [punch('in', D, '09:00')]), 10_000).status).toBe(
      'needsReview',
    );
    expect(
      dayPay(day('09:00', '18:00', [punch('in', D, '09:00')], at(D, '12:00')), 10_000).status,
    ).toBe('inProgress');
    expect(
      dayPay(day('09:00', '18:00', [punch('in', D, '09:00'), punch('out', D, '18:00')]), null)
        .status,
    ).toBe('noRate');
  });
});

describe('pay with more than one shift (2026-11-07)', () => {
  const D = '2026-11-05';
  test('a missed second shift costs its own minutes, not the whole day', () => {
    // 08–12 worked, 13–17 missed: half the planned minutes are short.
    const [d] = run(
      [shift('a', D, '08:00', '12:00'), shift('b', D, '13:00', '17:00')],
      [punch('in', D, '08:00'), punch('out', D, '12:00')],
      at(D, '23:00'),
    );
    expect(d!.flags).toEqual(['missedShift']);
    expect(d!.missedMinutes).toBe(240);
    expect(dayPay(d!, 10_000)).toEqual({
      status: 'payable',
      wageCents: 10_000,
      deductionCents: 5_000,
      netCents: 5_000,
    });
  });
  test('nothing punched all day is still absent', () => {
    const [d] = run(
      [shift('a', D, '08:00', '12:00'), shift('b', D, '13:00', '17:00')],
      [],
      at(D, '23:00'),
    );
    expect(d!.flags).toEqual(['absent']);
    expect(dayPay(d!, 10_000).status).toBe('absent');
  });
  test('punches at other hours than planned go to a manager, not to "absent"', () => {
    // Planned 18–23, worked 08–12.
    const [d] = run(
      [shift('a', D, '18:00', '23:00')],
      [punch('in', D, '08:00'), punch('out', D, '12:00')],
      at(D, '23:59'),
    );
    expect([...d!.flags].sort()).toEqual(['missedShift', 'unscheduled']);
    expect(dayPay(d!, 10_000).status).toBe('needsReview');
  });
  test('the later shift still to come: in progress', () => {
    const [d] = run(
      [shift('a', D, '08:00', '12:00'), shift('b', D, '13:00', '17:00')],
      [punch('in', D, '08:00'), punch('out', D, '12:00')],
      at(D, '12:30'),
    );
    expect(d!.flags).toEqual(['upcoming']);
    expect(dayPay(d!, 10_000).status).toBe('inProgress');
  });
});

test('overtime counts only past the threshold', () => {
  const end = at('2026-11-05', '18:00');
  expect(overtimeMinutes(end, at('2026-11-05', '18:20'), 30)).toBe(0);
  expect(overtimeMinutes(end, at('2026-11-05', '18:45'), 30)).toBe(45);
});
