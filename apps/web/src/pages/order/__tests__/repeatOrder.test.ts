import { describe, expect, it } from 'bun:test';
import { repeatOrderFill } from '../repeatOrder';

const skus = [
  { id: 'rice', unit: 'kg', step: '0.500' },
  { id: 'oil', unit: 'L', step: '1.000' },
  { id: 'salt', unit: 'pack', step: '1.000', isArchived: true },
  { id: 'eggs', unit: 'box', step: '1.000' },
];

describe('repeatOrderFill (UX-02)', () => {
  it('copies each line still orderable as it was, in the order given', () => {
    expect(
      repeatOrderFill(
        [
          { skuId: 'oil', qty: '3', unit: 'L' },
          { skuId: 'rice', qty: '2.500', unit: 'kg' },
        ],
        skus,
      ),
    ).toEqual([
      { skuId: 'oil', qty: '3' },
      { skuId: 'rice', qty: '2.5' },
    ]);
  });

  it('leaves out archived and unknown products, a changed unit or step, and nothing to order', () => {
    expect(
      repeatOrderFill(
        [
          { skuId: 'salt', qty: '1', unit: 'pack' },
          { skuId: 'gone', qty: '1', unit: 'kg' },
          { skuId: 'eggs', qty: '2', unit: 'pcs' },
          { skuId: 'rice', qty: '0.75', unit: 'kg' },
          { skuId: 'oil', qty: '0', unit: 'L' },
        ],
        skus,
      ),
    ).toEqual([]);
  });

  it('sets a product once, and nothing at all from no order', () => {
    expect(
      repeatOrderFill(
        [
          { skuId: 'oil', qty: '2', unit: 'L' },
          { skuId: 'oil', qty: '5', unit: 'L' },
        ],
        skus,
      ),
    ).toEqual([{ skuId: 'oil', qty: '2' }]);
    expect(repeatOrderFill([], skus)).toEqual([]);
  });
});
