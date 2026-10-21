/**
 * 2026-10-21 audit CA-23 (D-03): sales.list day boundaries follow the
 * store's business timezone (store.timezone || org timezone), not UTC.
 *
 * Pure date math — no Postgres needed.
 */
import { describe, expect, test } from 'bun:test';
import { salesListRange } from '../trpc/routers/sales';

describe('salesListRange', () => {
  test('Asia/Tashkent at UTC 20:00: default "today" is the local next day', () => {
    // 2026-10-21 20:00 UTC = 2026-10-22 01:00 Tashkent (UTC+5).
    const now = new Date('2026-10-21T20:00:00Z');
    const { from, toExclusive } = salesListRange('Asia/Tashkent', undefined, undefined, now);
    expect(from.toISOString()).toBe('2026-10-21T19:00:00.000Z');
    expect(toExclusive.toISOString()).toBe('2026-10-22T19:00:00.000Z');
    // The old UTC range was 2026-10-21T00:00Z..23:59Z — it mixed the
    // tail of local 10-21 with the first hour of local 10-22.
    expect(now >= from && now < toExclusive).toBe(true);
  });

  test('explicit dates are local business days, inclusive of the end day', () => {
    const { from, toExclusive } = salesListRange('Asia/Tashkent', '2026-10-01', '2026-10-31');
    expect(from.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(toExclusive.toISOString()).toBe('2026-10-31T19:00:00.000Z');
  });

  test('local 23:59 belongs to the day, local 00:00 to the next', () => {
    const { from, toExclusive } = salesListRange('Asia/Tashkent', '2026-10-22', '2026-10-22');
    const lastMinute = new Date('2026-10-22T18:59:00Z'); // 23:59 local
    const nextMidnight = new Date('2026-10-22T19:00:00Z'); // 00:00 local next day
    expect(lastMinute >= from && lastMinute < toExclusive).toBe(true);
    expect(nextMidnight < toExclusive).toBe(false);
  });

  test('UTC fallback keeps the old UTC boundaries', () => {
    const { from, toExclusive } = salesListRange('UTC', '2026-12-31', '2026-12-31');
    expect(from.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(toExclusive.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('DST: a 23-hour local day in Europe/Berlin (spring forward)', () => {
    const { from, toExclusive } = salesListRange('Europe/Berlin', '2026-03-29', '2026-03-29');
    expect(from.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(toExclusive.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});
