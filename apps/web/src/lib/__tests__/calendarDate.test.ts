/**
 * COREWEB2-21 (2026-11-11): business dates on the org's calendar. The
 * instants are UTC so the tests mean the same on any machine; only the
 * "phone's calendar" cases read the machine's own zone, through local
 * Date parts.
 */
import { describe, expect, test } from 'bun:test';
import {
  addDays,
  calendarParts,
  isoDate,
  localDateValue,
  mondayOf,
  orgMonth,
  orgToday,
} from '../calendarDate';

// 2026-10-31 20:30 UTC = 1 Nov 01:30 in Tashkent (UTC+5), 31 Oct 16:30 in
// New York: the org has moved to a new day, and a new month.
const LATE = new Date('2026-10-31T20:30:00Z');

describe('orgToday', () => {
  test("is the org's day, whatever the phone's", () => {
    expect(orgToday('Asia/Tashkent', LATE)).toBe('2026-11-01');
    expect(orgToday('America/New_York', LATE)).toBe('2026-10-31');
    expect(orgToday('UTC', LATE)).toBe('2026-10-31');
  });

  test("falls back to the phone's calendar without a zone", () => {
    expect(orgToday(undefined, new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  test("an unknown zone reads the phone's calendar instead of throwing", () => {
    expect(orgToday('Not/AZone', new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });
});

describe('orgMonth', () => {
  test("is the org's month", () => {
    expect(orgMonth('Asia/Tashkent', LATE)).toBe('2026-11');
    expect(orgMonth('America/New_York', LATE)).toBe('2026-10');
  });
});

describe('calendarParts / isoDate / localDateValue', () => {
  test('reads year, month and day in the zone', () => {
    expect(calendarParts(LATE, 'Asia/Tashkent')).toEqual({ y: 2026, m: 11, d: 1 });
  });

  test('zero-pads, and rolls an out-of-range day over', () => {
    expect(isoDate(2026, 1, 5)).toBe('2026-01-05');
    expect(isoDate(2026, 3, 0)).toBe('2026-02-28');
    expect(isoDate(2024, 3, 0)).toBe('2024-02-29');
    expect(isoDate(2026, 1, 0)).toBe('2025-12-31');
  });

  test('localDateValue is the zone (or phone) calendar date', () => {
    expect(localDateValue(LATE, 'Asia/Tashkent')).toBe('2026-11-01');
    expect(localDateValue(new Date(2026, 9, 21, 23, 59))).toBe('2026-10-21');
  });
});

// 2026-11-12: the attendance screens' day arithmetic, which AttendanceSettings
// borrowed from AttendanceManage.
describe('addDays / mondayOf', () => {
  test('moves across months, years and a leap day', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-13', 0)).toBe('2026-11-13');
  });

  test('a week starts on Monday, and Sunday is its last day', () => {
    expect(mondayOf('2026-11-09')).toBe('2026-11-09'); // Monday
    expect(mondayOf('2026-11-13')).toBe('2026-11-09'); // Friday
    expect(mondayOf('2026-11-15')).toBe('2026-11-09'); // Sunday
    expect(mondayOf('2027-01-02')).toBe('2026-12-28'); // across the year
  });
});
