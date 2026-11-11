import { describe, expect, it } from 'bun:test';
import { dateInTz, fixedClock, nextDate, todayInTz, zonedTimeToUtc } from './clock';

/**
 * Review TEST4-07 (2026-11): the business date comes from here, and only
 * the PG integration tests reached it, which the unit stage skips. The
 * stores run on Asia/Tashkent (UTC+5, no daylight saving): a day starts
 * at 19:00 UTC the evening before.
 */
describe('todayInTz / dateInTz', () => {
  it('turns the day at local midnight in Tashkent, not at UTC midnight', () => {
    expect(todayInTz('Asia/Tashkent', new Date('2026-11-09T18:59:59.999Z'))).toBe('2026-11-09');
    expect(todayInTz('Asia/Tashkent', new Date('2026-11-09T19:00:00.000Z'))).toBe('2026-11-10');
    expect(todayInTz('Asia/Tashkent', new Date('2026-11-09T23:30:00.000Z'))).toBe('2026-11-10');
    expect(todayInTz('UTC', new Date('2026-11-09T23:30:00.000Z'))).toBe('2026-11-09');
  });

  it('follows daylight saving where the zone has it', () => {
    // Los Angeles moves from UTC-8 to UTC-7 on 2026-03-08.
    const la = 'America/Los_Angeles';
    expect(dateInTz(new Date('2026-03-08T07:59:59Z'), la)).toBe('2026-03-07');
    expect(dateInTz(new Date('2026-03-08T08:00:00Z'), la)).toBe('2026-03-08');
    expect(dateInTz(new Date('2026-03-09T06:59:59Z'), la)).toBe('2026-03-08');
    expect(dateInTz(new Date('2026-03-09T07:00:00Z'), la)).toBe('2026-03-09');
  });

  it('crosses months and years, zero-padded', () => {
    expect(dateInTz(new Date('2025-12-31T19:00:00Z'), 'Asia/Tashkent')).toBe('2026-01-01');
    expect(dateInTz(new Date('2026-01-05T00:00:00Z'), 'UTC')).toBe('2026-01-05');
  });

  it('keeps one formatter per zone apart (the cache)', () => {
    const at = new Date('2026-11-09T20:00:00Z');
    const seen = ['Asia/Tashkent', 'UTC', 'Asia/Tashkent', 'America/Los_Angeles', 'UTC'].map((tz) =>
      dateInTz(at, tz),
    );
    expect(seen).toEqual(['2026-11-10', '2026-11-09', '2026-11-10', '2026-11-09', '2026-11-09']);
  });

  it('todayInTz and dateInTz agree for the same instant', () => {
    const at = new Date('2026-06-30T19:00:00Z');
    expect(todayInTz('Asia/Tashkent', at)).toBe(dateInTz(at, 'Asia/Tashkent'));
  });
});

describe('fixedClock', () => {
  it('hands out a copy, so a caller cannot move the clock', () => {
    const clock = fixedClock(new Date('2026-11-10T00:00:00Z'));
    clock.now().setUTCFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });
});

describe('zonedTimeToUtc / nextDate (CONF-16)', () => {
  it('reads a wall-clock time in the zone, on both sides of a DST change', () => {
    expect(zonedTimeToUtc('2026-11-10', '00:00', 'Asia/Tashkent').toISOString()).toBe(
      '2026-11-09T19:00:00.000Z',
    );
    // Berlin moves from UTC+1 to UTC+2 at 02:00 on 2026-03-29.
    expect(zonedTimeToUtc('2026-03-29', '00:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-29', '09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T07:00:00.000Z',
    );
    expect(() => zonedTimeToUtc('2026-3-29', '00:00', 'UTC')).toThrow();
    expect(() => zonedTimeToUtc('2026-03-29', '24:00', 'UTC')).toThrow();
  });

  it('steps dates across months and years, both ways', () => {
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
    expect(nextDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(nextDate('2028-02-28')).toBe('2028-02-29');
    expect(nextDate('2026-11-10', 7)).toBe('2026-11-17');
    expect(() => nextDate('10.11.2026')).toThrow();
  });
});
