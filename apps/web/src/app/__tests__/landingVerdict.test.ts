import { describe, expect, test } from 'bun:test';
import {
  LANDING_COUNTS_MAX_AGE_MS,
  LANDING_WINDOW_MS,
  landingVerdict,
  type LandingInput,
} from '../shell/landingVerdict';

const start: LandingInput = {
  visibleKeys: ['order', 'approve', 'history', 'admin'],
  currentTab: 'order',
  oneStore: true,
  deepLinked: false,
  userActed: false,
  elapsedMs: 0,
  counts: { approve: 2, ageMs: 0 },
};

describe('where a cold start lands (S2)', () => {
  test('on Review when an order waits there', () => {
    expect(landingVerdict(start)).toBe('review');
  });

  test('on a recent restored count, at once', () => {
    expect(landingVerdict({ ...start, counts: { approve: 1, ageMs: 60_000 } })).toBe('review');
  });

  test('where it was when nothing waits, or the count is withheld', () => {
    expect(landingVerdict({ ...start, counts: { approve: 0, ageMs: 0 } })).toBe('stay');
    expect(landingVerdict({ ...start, counts: { approve: null, ageMs: 0 } })).toBe('stay');
  });

  test('waits for a count, but not past the window', () => {
    expect(landingVerdict({ ...start, counts: null })).toBe('wait');
    expect(
      landingVerdict({
        ...start,
        counts: { approve: 3, ageMs: LANDING_COUNTS_MAX_AGE_MS + 1 },
      }),
    ).toBe('wait');
    expect(landingVerdict({ ...start, elapsedMs: LANDING_WINDOW_MS + 1 })).toBe('stay');
    expect(landingVerdict({ ...start, counts: null, elapsedMs: LANDING_WINDOW_MS + 1 })).toBe(
      'stay',
    );
  });

  test('never over a link, a tap, or without Review', () => {
    expect(landingVerdict({ ...start, deepLinked: true })).toBe('stay');
    expect(landingVerdict({ ...start, userActed: true })).toBe('stay');
    expect(landingVerdict({ ...start, visibleKeys: ['order', 'history'] })).toBe('stay');
  });

  test('not in the all-stores view, and not when already on Review', () => {
    expect(landingVerdict({ ...start, oneStore: false })).toBe('stay');
    expect(landingVerdict({ ...start, currentTab: 'approve' })).toBe('stay');
  });
});
