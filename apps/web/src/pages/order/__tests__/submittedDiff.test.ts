import { describe, expect, test } from 'bun:test';
import { extrasChanged, submittedDiff } from '../submittedDiff';

describe('submittedDiff', () => {
  test('changed, added and removed lines; unchanged ones left out', () => {
    const d = submittedDiff(
      [
        { skuId: 'a', qty: '3' },
        { skuId: 'b', qty: '1' },
        { skuId: 'c', qty: '2' },
      ],
      [
        { skuId: 'a', qty: '2.5' },
        { skuId: 'c', qty: '2.000' },
        { skuId: 'd', qty: '4' },
        { skuId: 'b', qty: '0' },
      ],
    );
    expect(Object.fromEntries(d)).toEqual({
      a: { kind: 'changed', before: 3, after: 2.5 },
      b: { kind: 'removed', before: 1 },
      d: { kind: 'added', after: 4 },
    });
  });
  test('nothing to compare without a submitted version', () => {
    expect(submittedDiff(null, [{ skuId: 'a', qty: '1' }]).size).toBe(0);
  });
  test('extras', () => {
    const x = [{ name: 'Ice', qty: '1', unit: 'pcs' }];
    expect(extrasChanged(x, [{ name: 'Ice ', qty: '1.0', unit: 'pcs' }])).toBe(false);
    expect(extrasChanged(x, [])).toBe(true);
    expect(extrasChanged(null, [])).toBe(false);
  });
});
