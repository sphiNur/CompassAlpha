/** 2026-10-21 FE-02: extras-only orders must not render as "empty". */
import { describe, it, expect } from 'bun:test';
import { sessionItemsView } from '../sessionItemsView';

describe('sessionItemsView', () => {
  it('extras-only order shows extras, SKU section empty, not overall empty', () => {
    const v = sessionItemsView({
      totals: [{ qty: '0' }],
      extras: [{ name: 'Foil', qty: '2', unit: 'pcs' }],
      notes: null,
    });
    expect(v.allEmpty).toBe(false);
    expect(v.showExtras).toBe(true);
    expect(v.hasSkus).toBe(false);
    expect(v.skuSectionEmpty).toBe(true);
  });

  it('legacy notes-only order shows notes', () => {
    const v = sessionItemsView({ totals: [], extras: [], notes: 'buy ice' });
    expect(v.allEmpty).toBe(false);
    expect(v.showNotes).toBe(true);
    expect(v.skuSectionEmpty).toBe(true);
  });

  it('nothing at all is the overall empty state', () => {
    const v = sessionItemsView({ totals: [{ qty: 0 }], extras: undefined, notes: '  ' });
    expect(v.allEmpty).toBe(true);
    expect(v.skuSectionEmpty).toBe(false);
    expect(v.showNotes).toBe(false);
  });

  it('SKU lines present: no empty state', () => {
    const v = sessionItemsView({ totals: [{ qty: '1.5' }], extras: [], notes: null });
    expect(v.allEmpty).toBe(false);
    expect(v.hasSkus).toBe(true);
    expect(v.skuSectionEmpty).toBe(false);
    expect(v.showExtras).toBe(false);
  });
});
