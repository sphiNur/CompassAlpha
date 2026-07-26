/**
 * Pins the carried-price logic behind Q7(b).
 *
 * `countCarriedOver` is the safety net for the whole feature: hiding the
 * price editor is only defensible because closing a run states how many
 * prices were accepted unchanged. If this count is wrong the feature is
 * a faster way to bill a shop last month's price.
 */
import { describe, it, expect } from 'bun:test';
import {
  priceRowState,
  priceAgeDays,
  isStalePrice,
  collapsedCommit,
  countCarriedOver,
  STALE_PRICE_DAYS,
} from '../priceState';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('priceRowState', () => {
  it('carries a pending row that has a reference price', () => {
    expect(priceRowState({ status: 'pending', lastPrice: '7000', expanded: false })).toBe('carried');
  });

  it('marks a pending row with no reference price as unpriced', () => {
    expect(priceRowState({ status: 'pending', lastPrice: null, expanded: false })).toBe('unpriced');
  });

  it('does not carry a reference that cannot be saved', () => {
    // These are all truthy strings, so the original `lastPrice ? ...`
    // rendered a one-tap 'carried' row with a ✓ — while canSave, which
    // requires Number(price) > 0, held that ✓ grey forever with no
    // reason shown anywhere on the row.
    for (const lastPrice of ['0', '0.00', '-5', 'abc']) {
      expect(priceRowState({ status: 'pending', lastPrice, expanded: false })).toBe(
        'unpriced',
      );
    }
  });

  it('still carries an ordinary sub-1 price', () => {
    // The guard is Number(x) > 0, not a length or format check — cheap
    // goods priced under one unit of currency must stay one-tappable.
    expect(priceRowState({ status: 'pending', lastPrice: '0.5', expanded: false })).toBe(
      'carried',
    );
  });

  it('switches to editing the moment the purchaser opens the row', () => {
    expect(priceRowState({ status: 'pending', lastPrice: '7000', expanded: true })).toBe('editing');
    expect(priceRowState({ status: 'pending', lastPrice: null, expanded: true })).toBe('editing');
  });

  it('never collapses a row that is not pending', () => {
    // purchased / unavailable rows have their own presentation.
    expect(priceRowState({ status: 'purchased', lastPrice: '7000', expanded: false })).toBe('editing');
    expect(priceRowState({ status: 'unavailable', lastPrice: null, expanded: false })).toBe('editing');
  });
});

describe('collapsedCommit', () => {
  const base = { status: 'pending', saving: false, plannedQty: '10', lastPrice: '70000' };

  it('commits exactly the figures the collapsed row prints', () => {
    expect(collapsedCommit(base)).toEqual({ qty: '10', price: '70000' });
  });

  it('refuses a row with no reference price', () => {
    // The regression. The ✓ used to arm itself from component state
    // seeded at mount, so after purchased -> revised -> undone a row
    // printing "?" in its money column still rendered a live blue ✓ and
    // committed the revised figures — numbers shown nowhere on screen.
    expect(collapsedCommit({ ...base, lastPrice: null })).toBeNull();
    expect(collapsedCommit({ ...base, lastPrice: '' })).toBeNull();
    expect(collapsedCommit({ ...base, lastPrice: '0' })).toBeNull();
    expect(collapsedCommit({ ...base, lastPrice: 'abc' })).toBeNull();
  });

  it('refuses a row with no usable planned quantity', () => {
    expect(collapsedCommit({ ...base, plannedQty: '0' })).toBeNull();
    expect(collapsedCommit({ ...base, plannedQty: null })).toBeNull();
  });

  it('refuses while a save is already in flight', () => {
    expect(collapsedCommit({ ...base, saving: true })).toBeNull();
  });

  it('refuses on any row that is not pending', () => {
    for (const status of ['purchased', 'unavailable']) {
      expect(collapsedCommit({ ...base, status })).toBeNull();
    }
  });

  it('depends only on the props the row renders, never on edit state', () => {
    // Whatever the component happens to hold locally cannot reach the
    // payload — that is the whole point of deriving it here.
    const a = collapsedCommit({ ...base, plannedQty: '10', lastPrice: '70000' });
    const b = collapsedCommit({ ...base, plannedQty: '10', lastPrice: '70000' });
    expect(a).toEqual(b);
    expect(a).toEqual({ qty: '10', price: '70000' });
  });

  it('passes decimals through untouched', () => {
    expect(collapsedCommit({ ...base, plannedQty: '1.250' })).toEqual({
      qty: '1.250',
      price: '70000',
    });
  });
});

describe('priceAgeDays / isStalePrice', () => {
  it('counts whole days', () => {
    expect(priceAgeDays(daysAgo(0), NOW)).toBe(0);
    expect(priceAgeDays(daysAgo(3), NOW)).toBe(3);
    expect(priceAgeDays(daysAgo(30), NOW)).toBe(30);
  });

  it('returns null for missing or unparseable input', () => {
    expect(priceAgeDays(null, NOW)).toBeNull();
    expect(priceAgeDays(undefined, NOW)).toBeNull();
    expect(priceAgeDays('not a date', NOW)).toBeNull();
  });

  it('treats a future timestamp as fresh, not negatively aged', () => {
    // The phone's clock can be ahead of the server's.
    expect(priceAgeDays(daysAgo(-2), NOW)).toBe(0);
    expect(isStalePrice(daysAgo(-2), NOW)).toBe(false);
  });

  it('is stale strictly beyond the threshold', () => {
    expect(isStalePrice(daysAgo(STALE_PRICE_DAYS), NOW)).toBe(false);
    expect(isStalePrice(daysAgo(STALE_PRICE_DAYS + 1), NOW)).toBe(true);
  });

  it('is not stale when there is no reference at all', () => {
    // "no price to trust" is a different problem, surfaced as unpriced.
    expect(isStalePrice(null, NOW)).toBe(false);
  });
});

describe('countCarriedOver', () => {
  const refs = { a: '7000', b: '5000', c: '100' };
  const fresh = { a: daysAgo(1), b: daysAgo(1), c: daysAgo(1) };

  it('counts a purchased row whose price equals the reference', () => {
    const out = countCarriedOver(
      [{ skuId: 'a', status: 'purchased', unitPrice: '7000' }],
      refs,
      fresh,
      NOW,
    );
    expect(out).toEqual({ carried: 1, stale: 0 });
  });

  it('does NOT count a price the purchaser actually changed', () => {
    const out = countCarriedOver(
      [{ skuId: 'a', status: 'purchased', unitPrice: '7500' }],
      refs,
      fresh,
      NOW,
    );
    expect(out.carried).toBe(0);
  });

  it('compares numerically, so 7000 and 7000.00 are the same price', () => {
    const out = countCarriedOver(
      [{ skuId: 'a', status: 'purchased', unitPrice: '7000.00' }],
      refs,
      fresh,
      NOW,
    );
    expect(out.carried).toBe(1);
  });

  it('ignores rows that were never purchased', () => {
    const out = countCarriedOver(
      [
        { skuId: 'a', status: 'pending', unitPrice: '7000' },
        { skuId: 'b', status: 'unavailable', unitPrice: null },
      ],
      refs,
      fresh,
      NOW,
    );
    expect(out.carried).toBe(0);
  });

  it('ignores a SKU with no reference price — nothing was carried', () => {
    const out = countCarriedOver(
      [{ skuId: 'zzz', status: 'purchased', unitPrice: '7000' }],
      refs,
      fresh,
      NOW,
    );
    expect(out.carried).toBe(0);
  });

  it('reports how many carried prices were already stale', () => {
    const out = countCarriedOver(
      [
        { skuId: 'a', status: 'purchased', unitPrice: '7000' },
        { skuId: 'b', status: 'purchased', unitPrice: '5000' },
        { skuId: 'c', status: 'purchased', unitPrice: '100' },
      ],
      refs,
      { a: daysAgo(1), b: daysAgo(30), c: daysAgo(9) },
      NOW,
    );
    expect(out).toEqual({ carried: 3, stale: 2 });
  });

  it('counts a carried price with no known observation date as not stale', () => {
    const out = countCarriedOver(
      [{ skuId: 'a', status: 'purchased', unitPrice: '7000' }],
      refs,
      {},
      NOW,
    );
    expect(out).toEqual({ carried: 1, stale: 0 });
  });

  it('is zero for an empty run', () => {
    expect(countCarriedOver([], refs, fresh, NOW)).toEqual({ carried: 0, stale: 0 });
  });

  it('ignores an unparseable saved price rather than counting it', () => {
    const out = countCarriedOver(
      [{ skuId: 'a', status: 'purchased', unitPrice: 'abc' }],
      refs,
      fresh,
      NOW,
    );
    expect(out.carried).toBe(0);
  });
});
