import { describe, expect, it } from 'bun:test';

import {
  allItemsHandled,
  allStoresConfirmed,
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
