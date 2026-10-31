import { describe, expect, it } from 'bun:test';
import { lastUpdatedLabel, oldestShownData } from '../useCachedDataAge';

// R2-ENG-1 / R2-SHL-2 (2026-10-31): the offline banner shows how old the
// data on screen is, or says there is none.
const q = (observers: number, data: unknown, at: number) => ({
  getObserversCount: () => observers,
  state: { data, dataUpdatedAt: at } as never,
});

describe('oldestShownData', () => {
  it('is the oldest load among queries on screen that have data', () => {
    expect(oldestShownData([q(1, 'a', 2000), q(1, 'b', 1000), q(0, 'gone', 10), q(1, undefined, 0)])).toBe(
      1000,
    );
  });
  it('is null when nothing on screen has data', () => {
    expect(oldestShownData([q(1, undefined, 0), q(0, 'x', 5)])).toBeNull();
  });
});

describe('lastUpdatedLabel', () => {
  it('shows the time today and the date on an earlier day', () => {
    const now = new Date(2026, 9, 31, 15, 0).getTime();
    expect(lastUpdatedLabel(new Date(2026, 9, 31, 9, 5).getTime(), now)).toBe('09:05');
    expect(lastUpdatedLabel(new Date(2026, 9, 30, 18, 20).getTime(), now)).toBe('10-30 18:20');
  });
});
