import { describe, expect, test } from 'bun:test';
import { adjustingSessionIds } from '../adjustInFlight';

describe('adjustingSessionIds (DX-APR-1)', () => {
  test('collects the orders of pending quantity changes', () => {
    const ids = adjustingSessionIds([
      { sessionId: 'a', skuId: 's1', qty: '4' },
      { sessionId: 'a', skuId: 's2', qty: '1' },
      { sessionId: 'b', skuId: 's1', qty: '2' },
    ]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  test('ignores mutations without variables', () => {
    expect(adjustingSessionIds([undefined, null, {}, { sessionId: 3 }]).size).toBe(0);
  });
});
