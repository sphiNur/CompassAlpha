import { describe, expect, it } from 'bun:test';

import {
  allItemsHandled,
  allStoresConfirmed,
  deliveryWaiting,
  itemProgressCounts,
  pendingItemCount,
  type SplitLike,
} from '../runProgress';

const split = (over: Partial<SplitLike> & { storeId: string }): SplitLike => ({
  confirmedAt: null,
  deliveredAt: null,
  ...over,
});

describe('allStoresConfirmed', () => {
  it('is true when a trip bought nothing — the finish button must exist', () => {
    // Market shut / supplier absent: every item unavailable, so no
    // splits. This answered false and deleted the Finish button, which
    // left Cancel as the only exit and discarded the record that every
    // item had been checked.
    expect(allStoresConfirmed([])).toBe(true);
  });

  it('is false while any store still has an unconfirmed split', () => {
    expect(
      allStoresConfirmed([
        split({ storeId: 'a', confirmedAt: '2026-07-27T06:00:00Z' }),
        split({ storeId: 'b' }),
      ]),
    ).toBe(false);
  });

  it('is false when one store confirmed only part of its splits', () => {
    expect(
      allStoresConfirmed([
        split({ storeId: 'a', confirmedAt: '2026-07-27T06:00:00Z' }),
        split({ storeId: 'a' }),
      ]),
    ).toBe(false);
  });

  it('is true once every split of every store is confirmed', () => {
    expect(
      allStoresConfirmed([
        split({ storeId: 'a', confirmedAt: '2026-07-27T06:00:00Z' }),
        split({ storeId: 'a', confirmedAt: '2026-07-27T06:01:00Z' }),
        split({ storeId: 'b', confirmedAt: '2026-07-27T06:02:00Z' }),
      ]),
    ).toBe(true);
  });

  it('treats an empty-string timestamp as not confirmed', () => {
    expect(allStoresConfirmed([split({ storeId: 'a', confirmedAt: '' })])).toBe(
      false,
    );
  });
});

describe('allItemsHandled', () => {
  it('is false for a run with no items — that is bad data, not a done trip', () => {
    expect(allItemsHandled([])).toBe(false);
  });

  it('is true when everything was bought', () => {
    expect(
      allItemsHandled([{ status: 'purchased' }, { status: 'purchased' }]),
    ).toBe(true);
  });

  it('is true when everything was unavailable', () => {
    // The case that pairs with allStoresConfirmed([]) above: this side
    // already allowed the run to advance to delivering, which is how it
    // reached the dead end.
    expect(
      allItemsHandled([{ status: 'unavailable' }, { status: 'unavailable' }]),
    ).toBe(true);
  });

  it('is true for a mix of bought and unavailable', () => {
    expect(
      allItemsHandled([{ status: 'purchased' }, { status: 'unavailable' }]),
    ).toBe(true);
  });

  it('is false while anything is still pending', () => {
    expect(
      allItemsHandled([{ status: 'purchased' }, { status: 'pending' }]),
    ).toBe(false);
  });
});

describe('pendingItemCount', () => {
  it('counts only items still awaiting a decision', () => {
    expect(
      pendingItemCount([
        { status: 'purchased' },
        { status: 'pending' },
        { status: 'unavailable' },
        { status: 'pending' },
      ]),
    ).toBe(2);
  });

  it('is 0 exactly when allItemsHandled is true', () => {
    const done = [{ status: 'purchased' }, { status: 'unavailable' }];
    expect(pendingItemCount(done)).toBe(0);
    expect(allItemsHandled(done)).toBe(true);
  });

  it('is 0 for an empty run — allItemsHandled is false there, and that is the point', () => {
    // A run with no items is a data problem, not a finished trip. The
    // count says "nothing pending"; the gate still refuses to advance.
    expect(pendingItemCount([])).toBe(0);
    expect(allItemsHandled([])).toBe(false);
  });
});

describe('itemProgressCounts (R2-BUY-5)', () => {
  it('counts like the bottom bar: an item with later demand is left, not bought', () => {
    const items = [
      { status: 'purchased' },
      { status: 'purchased', topUpQty: '4' },
      { status: 'unavailable' },
      { status: 'pending' },
    ];
    const counts = itemProgressCounts(items);
    expect(counts).toEqual({ bought: 1, na: 1, pending: 2 });
    expect(counts.pending).toBe(pendingItemCount(items));
  });
});

describe('deliveryWaiting (U7)', () => {
  it('names stores to deliver to, then stores to confirm', () => {
    const splits = [
      split({ storeId: 'A', deliveredAt: 't', confirmedAt: 't' }),
      split({ storeId: 'B', deliveredAt: 't' }),
      split({ storeId: 'C' }),
      split({ storeId: 'B', deliveredAt: 't' }),
      split({ storeId: 'D', deliveredAt: 't' }),
      split({ storeId: 'D' }),
    ];
    expect(deliveryWaiting(splits)).toEqual({ undelivered: ['C', 'D'], unconfirmed: ['B'] });
  });

  it('nothing to wait for once every store confirmed', () => {
    expect(deliveryWaiting([split({ storeId: 'A', deliveredAt: 't', confirmedAt: 't' })])).toEqual({
      undelivered: [],
      unconfirmed: [],
    });
  });
});
