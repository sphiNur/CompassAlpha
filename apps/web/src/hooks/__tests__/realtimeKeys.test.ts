import { describe, expect, test } from 'bun:test';
import { ORDER_CHANGED_KEYS, RUN_CHANGED_KEYS } from '../realtimeKeys';

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
