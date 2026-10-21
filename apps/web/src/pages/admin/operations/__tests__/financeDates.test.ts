/**
 * 2026-10-21 audit CA-23 (D-05): Finance presets must follow the device's
 * LOCAL calendar. The old `toISOString()` path returned the previous UTC
 * day east of UTC — "this month" began on the last day of last month.
 *
 * Each case passes an explicit IANA zone and builds `now` from a fixed UTC
 * instant, so the result is machine-independent and doesn't rely on
 * mutating process.env.TZ (unreliable once Date has been used in-process).
 */
import { describe, expect, test } from 'bun:test';
import { financePresetRange, localDateValue } from '../financeDates';

describe('financePresetRange in Asia/Tashkent (UTC+5)', () => {
  // 2026-03-01 02:30 local = 2026-02-28 21:30 UTC: local and UTC
  // calendars disagree on day AND month.
  const now = new Date('2026-02-28T21:30:00Z');

  test('local date is read without a UTC shift', () => {
    expect(localDateValue(now, 'Asia/Tashkent')).toBe('2026-03-01');
  });

  test('today / yesterday', () => {
    expect(financePresetRange('today', now, 'Asia/Tashkent')).toEqual({
      startDate: '2026-03-01',
      endDate: '2026-03-01',
    });
    expect(financePresetRange('yesterday', now, 'Asia/Tashkent')).toEqual({
      startDate: '2026-02-28',
      endDate: '2026-02-28',
    });
  });

  test('this month starts on the 1st, not the last day of last month', () => {
    expect(financePresetRange('thisMonth', now, 'Asia/Tashkent')).toEqual({
      startDate: '2026-03-01',
      endDate: '2026-03-01',
    });
  });

  test('last month covers its full last day', () => {
    expect(financePresetRange('lastMonth', now, 'Asia/Tashkent')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
  });
});

describe('financePresetRange west of UTC (America/New_York)', () => {
  // 2026-01-31 22:00 local = 2026-02-01 03:00 UTC.
  const now = new Date('2026-02-01T03:00:00Z');

  test('presets stay on the local January calendar', () => {
    expect(financePresetRange('today', now, 'America/New_York')).toEqual({
      startDate: '2026-01-31',
      endDate: '2026-01-31',
    });
    expect(financePresetRange('thisMonth', now, 'America/New_York')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(financePresetRange('lastMonth', now, 'America/New_York')).toEqual({
      startDate: '2025-12-01',
      endDate: '2025-12-31',
    });
  });
});

describe('financePresetRange in UTC', () => {
  test('leap-year February', () => {
    expect(financePresetRange('lastMonth', new Date('2028-03-10T12:00:00Z'), 'UTC')).toEqual({
      startDate: '2028-02-01',
      endDate: '2028-02-29',
    });
  });
});
