import { describe, expect, test } from 'bun:test';
import { pendingChangeCount } from '../pendingChanges';

describe('pendingChangeCount', () => {
  test('taps on one product count once; different products and targets count apart', () => {
    const e = (clientSeq: number, procedure: string, input: unknown) => ({ clientSeq, procedure, input });
    expect(
      pendingChangeCount([
        e(1, 'order.adjustItem', { storeId: 'ck', skuId: 'lamb', delta: '0.5' }),
        e(2, 'order.adjustItem', { storeId: 'ck', skuId: 'lamb', delta: '0.5' }),
        e(3, 'order.adjustItem', { storeId: 'ck', skuId: 'tomato', delta: '1' }),
        e(4, 'order.setSessionExtras', { sessionId: 's1', extras: [] }),
        e(5, 'misc', {}),
        e(6, 'misc', null),
      ]),
    ).toBe(5);
    expect(pendingChangeCount([])).toBe(0);
  });
});
