import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun } from './index';
import type { RunCommand } from './commands';
import {
  RUN_CLOCK as clock,
  RUN_NOW as NOW,
  confirmStoreItem,
  deliver,
  planAndPurchase,
  runStepper,
} from '../testing';

const { step } = runStepper(clock);

// 2026-10-21 CA-06: a problem line records how much actually arrived.
describe('run.receivedQty', () => {
  const delivered = (splits?: Array<{ storeId: string; qty: string }>) => {
    let s = planAndPurchase(splits ? { storeSplits: splits } : undefined);
    s = deliver(s);
    return s;
  };
  const issue = (status: 'ok' | 'short' | 'wrong' | 'quality', receivedQty?: string): RunCommand =>
    confirmStoreItem({
      skuId: 'sku-1',
      status,
      note: status === 'ok' ? null : 'problem',
      ...(receivedQty !== undefined ? { receivedQty } : {}),
    });
  const payloadOf = (evs: ReturnType<typeof decideRun>) => {
    const e = evs[0];
    if (e?.type !== 'StoreItemConfirmed') throw new Error('expected StoreItemConfirmed');
    return e.payload;
  };

  test('short requires a received qty', () => {
    expect(() => decideRun(delivered(), issue('short'), clock)).toThrow(
      'run.errors.receivedQtyRequired',
    );
    expect(payloadOf(decideRun(delivered(), issue('short', '2.5'), clock)).receivedQty).toBe('2.5');
  });

  test('received qty may not exceed the store split and must be a non-negative decimal', () => {
    const s = delivered([
      { storeId: 'A', qty: '1' },
      { storeId: 'B', qty: '3' },
    ]);
    expect(() => decideRun(s, issue('short', '1.5'), clock)).toThrow(
      'run.errors.receivedQtyExceedsSplit',
    );
    expect(() => decideRun(s, issue('short', '-1'), clock)).toThrow(
      'run.errors.receivedQtyInvalid',
    );
    expect(() => decideRun(s, issue('short', 'abc'), clock)).toThrow(
      'run.errors.receivedQtyInvalid',
    );
    expect(payloadOf(decideRun(s, issue('short', '0.5'), clock)).receivedQty).toBe('0.5');
  });

  test('short with the whole split received is refused; wrong / quality may keep it all (DLV-12)', () => {
    const s = delivered([
      { storeId: 'A', qty: '1' },
      { storeId: 'B', qty: '3' },
    ]);
    expect(() => decideRun(s, issue('short', '1'), clock)).toThrow(
      'run.errors.receivedQtyNotShort',
    );
    expect(() => decideRun(s, issue('short', '1.000'), clock)).toThrow(
      'run.errors.receivedQtyNotShort',
    );
    expect(payloadOf(decideRun(s, issue('quality', '1'), clock)).receivedQty).toBe('1');
  });

  test('wrong / quality default to zero received', () => {
    expect(payloadOf(decideRun(delivered(), issue('wrong'), clock)).receivedQty).toBe('0');
    expect(payloadOf(decideRun(delivered(), issue('quality'), clock)).receivedQty).toBe('0');
  });

  test('ok carries no received qty (old event shape) even if one is sent', () => {
    const payload = payloadOf(decideRun(delivered(), issue('ok', '1'), clock));
    expect('receivedQty' in payload).toBe(false);
  });

  test('state keeps the received qty; changing only the qty appends a new event', () => {
    let s = delivered();
    s = step(s, issue('short', '2'));
    expect(s.stores.get('A')?.itemConfirms.get('sku-1')?.receivedQty).toBe('2');
    expect(decideRun(s, issue('short', '2'), clock)).toEqual([]);
    expect(decideRun(s, issue('short', '3'), clock)).toHaveLength(1);
  });

  test('a legacy StoreItemConfirmed without receivedQty still applies', () => {
    let s = delivered();
    s = applyRun(s, {
      streamId: s.streamId,
      seq: s.seq + 1,
      occurredAt: NOW,
      actorUserId: 'u2',
      actorMemberId: 'm2',
      type: 'StoreItemConfirmed',
      payload: { storeId: 'A', skuId: 'sku-1', status: 'short', note: 'old', photoUrl: null },
    });
    expect(s.stores.get('A')?.itemConfirms.get('sku-1')?.receivedQty).toBeNull();
  });
});
