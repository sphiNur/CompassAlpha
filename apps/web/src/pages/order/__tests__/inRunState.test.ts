import { describe, expect, it } from 'bun:test';
import { inRunState } from '../inRunState';

const split = (storeId: string, delivered: boolean, confirmed = false) => ({
  storeId,
  deliveredAt: delivered ? '2026-11-01T10:00:00Z' : null,
  confirmedAt: confirmed ? '2026-11-01T11:00:00Z' : null,
});

describe('inRunState (DX-DLV-13)', () => {
  it('is "buying" until the run delivers, or without a run to read', () => {
    expect(inRunState(undefined, 'A')).toBe('buying');
    expect(inRunState({ status: 'purchasing', splits: [split('A', false)] }, 'A')).toBe('buying');
  });
  it('follows this store through delivery', () => {
    expect(inRunState({ status: 'delivering', splits: [split('A', false), split('B', true)] }, 'A')).toBe('onTheWay');
    expect(inRunState({ status: 'delivering', splits: [split('A', true)] }, 'A')).toBe('toCheck');
    expect(inRunState({ status: 'delivering', splits: [split('A', true, true)] }, 'A')).toBe('checked');
    expect(
      inRunState({ status: 'delivering', splits: [split('A', false)], recalledStoreIds: ['A'] }, 'A'),
    ).toBe('recalled');
  });
});
