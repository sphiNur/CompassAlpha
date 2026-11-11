import { describe, expect, it } from 'bun:test';
import { frozenOrderDate } from '../orderDate';

describe('frozenOrderDate (CA-25)', () => {
  // 2026-10-20 20:30 UTC: already 21 Oct 01:30 in Tashkent.
  const now = new Date('2026-10-20T20:30:00Z');

  it("uses the shown session's order date when there is a real session", () => {
    expect(frozenOrderDate({ id: 'sess-1', orderDate: '2026-10-20' }, 'Asia/Tashkent', now)).toBe(
      '2026-10-20',
    );
  });

  it("falls back to today on the org's calendar before a session exists (COREWEB2-21)", () => {
    expect(frozenOrderDate(null, 'Asia/Tashkent', now)).toBe('2026-10-21');
    expect(frozenOrderDate(undefined, 'Asia/Tashkent', now)).toBe('2026-10-21');
    // A phone in another zone does not move the org's day.
    expect(frozenOrderDate(null, 'Asia/Tashkent', now)).not.toBe(
      frozenOrderDate(null, 'America/New_York', now),
    );
    // The optimistic placeholder's date is not server truth.
    expect(
      frozenOrderDate({ id: 'optimistic', orderDate: '2026-10-22' }, 'Asia/Tashkent', now),
    ).toBe('2026-10-21');
  });

  it("uses the phone's calendar when the session names no zone", () => {
    const local = new Date(2026, 9, 21, 23, 59); // local 2026-10-21 23:59
    expect(frozenOrderDate(null, undefined, local)).toBe('2026-10-21');
  });
});
