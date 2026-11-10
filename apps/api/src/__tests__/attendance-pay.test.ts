/**
 * Pay and overtime: late deductions, overtime that needs a reason and an
 * approval, the month's export, and overnight shifts.
 *
 * Each test gets a workspace of its own (helpers/attendance.ts). Split out
 * of attendance.test.ts by theme (review TEST1-17, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { attendance, dateInTz, todayInTz } from '@compass/domain';
import { Hono } from 'hono';
import { attendanceMonthExport } from '../http/attendanceExport';
import { SHOULD_RUN } from './helpers/pg';
import {
  attendanceSuite,
  fixture,
  anyPhoneAnywhere,
  clock,
  expectError,
  staffReady,
  OTHER_DEVICE,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance pay and overtime', () => {
  /**
   * Ali's shift from five hours ago to an hour ago, at 100,000 a day,
   * clocked in 20 minutes late (the manager enters it). Returns the
   * shift's date.
   */
  async function lateShift(): Promise<string> {
    const f = fixture();
    const now = new Date();
    const start = new Date(now.getTime() - 5 * 3600_000);
    const end = new Date(now.getTime() - 3600_000);
    const date = dateInTz(start, TZ);
    const hhmm = (d: Date) => attendance.localTime(d, TZ);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date,
      start: hhmm(start),
      end: hhmm(end),
    });
    await f.manager.attendance.payRateSet({
      storeId: f.storeId,
      memberId: f.staffId,
      dailyWage: '100000',
      effectiveFrom: '2020-01-01',
    });
    // Clocked in 20 minutes late (the manager enters it).
    const lateIn = new Date(start.getTime() + 20 * 60_000);
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: dateInTz(lateIn, TZ),
      time: hhmm(lateIn),
      reason: 'phone was flat',
    });
    return date;
  }

  test('late is deducted; a late clock-out needs a reason and an approval', async () => {
    const f = fixture();
    await staffReady();
    const date = await lateShift();
    // Clocking out an hour after the end needs a reason …
    await expectError(
      clock(f.staff(), { kind: 'out', device: OTHER_DEVICE }),
      'attendance.errors.overtimeReasonRequired',
    );
    const out = await clock(f.staff(), {
      kind: 'out',
      device: OTHER_DEVICE,
      overtimeReason: 'Stocktake after closing',
    });
    expect(out.overtimeMinutes).toBeGreaterThanOrEqual(59);

    let sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const ot = sheet.overtime.find((o) => o.punchId === out.id)!;
    expect(ot.status).toBe('pending');
    expect(ot.reason).toBe('Stocktake after closing');
    const day = sheet.days.find((d) => d.memberId === f.staffId && d.date === date)!;
    expect(day.lateMinutes).toBe(20);
    // 240 planned minutes, 20 late → 100000 × 20 / 240 = 8333.33
    expect(day.pay).toEqual({
      status: 'payable',
      wageCents: 10_000_000,
      deductionCents: 833_333,
      netCents: 9_166_667,
    });

    await f.manager.attendance.overtimeDecide({
      storeId: f.storeId,
      overtimeId: ot.id,
      approve: false,
      note: 'Stayed for dinner',
    });
    sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.overtime.find((o) => o.id === ot.id)!.status).toBe('rejected');

    const wages = await f.manager.attendance.wageSuggestions({ storeId: f.storeId, date });
    expect(wages.find((w) => w.memberId === f.staffId)).toMatchObject({
      status: 'payable',
      amount: '91666.67',
      deduction: '8333.33',
      lateMinutes: 20,
    });
    await expectError(
      f.staff().attendance.wageSuggestions({ storeId: f.storeId, date }),
      'auth.errors.missingPermission',
    );
  });

  test('the month exports as an xlsx behind a signed link', async () => {
    const f = fixture();
    await staffReady();
    const date = await lateShift();
    await clock(f.staff(), {
      kind: 'out',
      device: OTHER_DEVICE,
      overtimeReason: 'Stocktake after closing',
    });
    // The month of the shift. "This month" missed it on the first of a
    // month between midnight and 05:00 in Tashkent, when the shift began
    // the day before (review TEST1-08).
    const month = date.slice(0, 7);
    await expectError(
      f.staff().attendance.exportLink({ storeId: f.storeId, month, locale: 'en' }),
      'auth.errors.missingPermission',
    );
    const link = await f.manager.attendance.exportLink({ storeId: f.storeId, month, locale: 'zh' });
    expect(link.path).toStartWith('/files/attendance-month.xlsx?t=');
    expect(link.fileName).toEndWith(`-${month}.xlsx`);
    const http = new Hono().get('/files/attendance-month.xlsx', attendanceMonthExport);
    const res = await http.request(link.path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    // Stored (uncompressed) zip: the sheet XML is readable as is.
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('每日明细');
    expect(text).toContain('91666.67');
    expect(text).toContain('Stocktake after closing');

    const bad = await http.request('/files/attendance-month.xlsx?t=nope');
    expect(bad.status).toBe(410);
  });

  test("an overnight clock-out and its overtime count for the shift's day, also when entered later", async () => {
    const f = fixture();
    // Ten days ago, entered by a manager now: the overtime row is created
    // today, its clock-out is ten days old.
    const day = attendance.nextDate(todayInTz(TZ, new Date()), -10);
    const nextDay = attendance.nextDate(day);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: day,
      start: '20:00',
      end: '23:00',
    });
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: day,
      time: '20:00',
      reason: 'Overnight test',
    });
    const out = await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'out',
      date: nextDay,
      time: '00:30',
      reason: 'Overnight test',
    });

    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: day, to: day });
    const punch = sheet.punches.find((p) => p.id === out.id)!;
    expect({ date: punch.date, day: punch.day }).toEqual({ date: nextDay, day });
    const row = sheet.days.find((d) => d.memberId === f.staffId && d.date === day)!;
    expect(row.punchIds).toContain(out.id);
    expect(row.workedMinutes).toBe(270);
    // It used to be in no sheet: loaded by when the record was made, and
    // dated by the clock-out's own day. A manager's entry approves it.
    expect(sheet.overtime.find((o) => o.punchId === out.id)).toMatchObject({
      date: day,
      minutes: 90,
      status: 'approved',
    });
    const next = await f.manager.attendance.sheet({
      storeId: f.storeId,
      from: nextDay,
      to: nextDay,
    });
    expect(next.overtime.find((o) => o.punchId === out.id)).toBeUndefined();

    // The month's file puts the clock-out and its overtime on that row.
    const link = await f.manager.attendance.exportLink({
      storeId: f.storeId,
      month: day.slice(0, 7),
      locale: 'en',
    });
    const http = new Hono().get('/files/attendance-month.xlsx', attendanceMonthExport);
    const text = new TextDecoder().decode(
      new Uint8Array(await (await http.request(link.path)).arrayBuffer()),
    );
    const daily = text.slice(text.lastIndexOf('<sheetData>'));
    const dayRow = [...daily.matchAll(/<row r="\d+">[\s\S]*?<\/row>/g)]
      .map((m) => m[0])
      .find((r) => r.includes(`>${day}<`) && r.includes('00:30'));
    expect(dayRow).toBeDefined();
    expect(dayRow).toContain(`00:30 (${nextDay}) (manual)`);
    expect(dayRow).toContain('>90<');
  });
});

describe.skipIf(!SHOULD_RUN)('attendance straight-on punch (2026-11-07)', () => {
  test('the challenge says when a clock-out will need a reason', async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    // Next is a clock-in: nothing to ask.
    const toIn = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect(toIn.overtimeMinutes).toBe(0);
    // Clocked in at the start of a shift that ended an hour ago.
    const start = new Date(Date.now() - 5 * 3600_000);
    const end = new Date(Date.now() - 3600_000);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: dateInTz(start, TZ),
      start: attendance.localTime(start, TZ),
      end: attendance.localTime(end, TZ),
    });
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: dateInTz(start, TZ),
      time: attendance.localTime(start, TZ),
      reason: 'test',
    });
    const toOut = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect(toOut.overtimeMinutes).toBeGreaterThanOrEqual(59);
    // A colleague's is known only once their face is.
    const colleague = await f.staff().attendance.livenessChallenge({
      storeId: f.storeId,
      identify: true,
    });
    expect(colleague.overtimeMinutes).toBe(0);
  });
});
