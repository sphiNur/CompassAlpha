import { describe, expect, it } from 'bun:test';
import { navBadges } from '../navBadges';

describe('navBadges (DX-SHL-23)', () => {
  const counts = { approve: 3, run: 0, confirm: 1, settlementDue: true };
  it('badges the visible tabs with something waiting', () => {
    expect(navBadges(counts, ['order', 'approve', 'run', 'confirm', 'settlement'])).toEqual({
      approve: 3,
      confirm: 1,
      settlement: 'dot',
    });
  });
  it('draws nothing for hidden tabs, withheld counts or no answer yet', () => {
    expect(navBadges(counts, ['order'])).toEqual({});
    expect(
      navBadges({ approve: null, run: null, confirm: null, settlementDue: null }, ['approve']),
    ).toEqual({});
    expect(navBadges({ ...counts, settlementDue: false }, ['settlement'])).toEqual({});
    expect(navBadges(undefined, ['approve'])).toEqual({});
  });
  it('A1: face enrollments to approve badge Admin', () => {
    expect(navBadges({ ...counts, faceEnrollPending: 2 }, ['admin'])).toEqual({ admin: 2 });
    expect(navBadges({ ...counts, faceEnrollPending: 0 }, ['admin'])).toEqual({});
    expect(navBadges({ ...counts, faceEnrollPending: null }, ['admin'])).toEqual({});
    expect(navBadges(counts, ['admin'])).toEqual({});
  });
});
