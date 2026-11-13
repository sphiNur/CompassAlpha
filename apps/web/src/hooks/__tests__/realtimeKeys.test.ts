import { describe, expect, test } from 'bun:test';
import {
  ORDER_CHANGED_KEYS,
  PUSH_KEYS,
  REOPEN_KEYS,
  RUN_CHANGED_KEYS,
  SETTLEMENT_CHANGED_KEYS,
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
      [
        ['order'],
        ['run'],
        ['report'],
        ['nav'],
        ['admin'],
        ['catalog'],
        ['attendance'],
        ['settlement', 'recent'],
        ['settlement', 'revisions'],
        // S4 / S5 (2026-11-13): the close's wage picker and templates.
        ['settlement', 'wageRoster'],
        ['settlement', 'expenseTemplates'],
      ].sort(),
    );
  });
});

describe('a daily close saved elsewhere (CONF-26)', () => {
  test('refreshes the recent closes, their history and the nav dot', () => {
    expect(SETTLEMENT_CHANGED_KEYS).toContainEqual(['settlement', 'recent']);
    expect(SETTLEMENT_CHANGED_KEYS).toContainEqual(['settlement', 'revisions']);
    expect(SETTLEMENT_CHANGED_KEYS).toContainEqual(['nav']);
  });

  test('never the record under the form, by a push or a reopened socket', () => {
    for (const keys of [SETTLEMENT_CHANGED_KEYS, REOPEN_KEYS]) {
      for (const key of keys) {
        expect(key.length === 1 && key[0] === 'settlement').toBe(false);
        expect(key[0] === 'settlement' && key[1] === 'get').toBe(false);
      }
    }
  });
});
