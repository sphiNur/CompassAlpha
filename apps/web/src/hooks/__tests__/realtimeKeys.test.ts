import { describe, expect, test } from 'bun:test';
import {
  ORDER_CHANGED_KEYS,
  PUSH_KEYS,
  REOPEN_KEYS,
  RUN_CHANGED_KEYS,
  coveringKeys,
} from '../realtimeKeys';

describe('realtime invalidation keys (DX-CAT-1)', () => {
  test('order and run pushes refresh Operations → Activity', () => {
    for (const keys of [ORDER_CHANGED_KEYS, RUN_CHANGED_KEYS]) {
      expect(keys).toContainEqual(['admin', 'recentEvents']);
      expect(keys).toContainEqual(['admin', 'overview']);
    }
  });

  test('and still what they refreshed before', () => {
    expect(ORDER_CHANGED_KEYS).toContainEqual(['order']);
    expect(ORDER_CHANGED_KEYS).toContainEqual(['admin', 'submissionHistory']);
    expect(RUN_CHANGED_KEYS).toContainEqual(['run']);
    expect(RUN_CHANGED_KEYS).toContainEqual(['report']);
    expect(RUN_CHANGED_KEYS).toContainEqual(['catalog', 'skuPriceStats']);
    // DX-SHL-23: nav badges follow both.
    expect(ORDER_CHANGED_KEYS).toContainEqual(['nav']);
    expect(RUN_CHANGED_KEYS).toContainEqual(['nav']);
  });
});

describe('COREWEB2-09', () => {
  test("an order push refreshes the purchaser's list of orders a run can take", () => {
    expect(ORDER_CHANGED_KEYS).toContainEqual(['run', 'previewCreatable']);
  });
});

describe('re-open refresh (COREWEB2-08)', () => {
  test('covers every key any push refreshes', () => {
    for (const keys of Object.values(PUSH_KEYS)) {
      for (const key of keys) {
        expect(REOPEN_KEYS.some((k) => k.every((part, i) => part === key[i]))).toBe(true);
      }
    }
  });

  test('includes the finance reports and attendance it used to miss, not the dead notifications key', () => {
    expect(REOPEN_KEYS).toContainEqual(['report']);
    expect(REOPEN_KEYS).toContainEqual(['attendance']);
    expect(REOPEN_KEYS.flat()).not.toContain('notifications');
  });

  test('keeps only the shortest covering keys', () => {
    expect(
      coveringKeys([['admin', 'overview'], ['run'], ['admin'], ['run'], ['run', 'x']]),
    ).toEqual([['run'], ['admin']]);
    expect([...REOPEN_KEYS].sort()).toEqual(
      [['order'], ['run'], ['report'], ['nav'], ['admin'], ['catalog'], ['attendance']].sort(),
    );
  });
});
