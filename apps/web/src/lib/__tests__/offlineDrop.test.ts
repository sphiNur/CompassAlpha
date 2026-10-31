import { describe, expect, test } from 'bun:test';
import { offlineDropText } from '../offlineDrop';

const catalog: Record<string, string> = {
  'run.toast.syncFailed': 'A saved change did not sync',
  'offline.action.confirmStore': 'Confirm receipt',
  'offline.drop.withReason': '{action} did not sync: {reason}',
  'offline.drop.generic': '{action} did not sync — please check',
  'run.errors.storeItemsUnchecked': '2 lines still to check',
  'order.errors.staleOfflineEdit': 'That day is over; the change was not saved',
};
const t = (key: string, values?: Record<string, string | number>) => {
  const text = catalog[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
};

describe('offlineDropText (RE-DLV-4 / R2-DLV-3)', () => {
  test('names the action and the server reason', () => {
    expect(
      offlineDropText(t as never, {
        procedure: 'run.confirmStore',
        reason: 'rejected',
        message: 'run.errors.storeItemsUnchecked',
      }),
    ).toBe('Confirm receipt did not sync: 2 lines still to check');
  });

  test('without a known reason, the action alone', () => {
    expect(
      offlineDropText(t as never, {
        procedure: 'run.confirmStore',
        reason: 'rejected',
        message: 'run.errors.somethingUnknown',
      }),
    ).toBe('Confirm receipt did not sync — please check');
    expect(offlineDropText(t as never, { procedure: 'run.confirmStore', reason: 'gaveup' })).toBe(
      'Confirm receipt did not sync — please check',
    );
  });

  test('a procedure this page does not know keeps the generic copy', () => {
    expect(offlineDropText(t as never, { procedure: 'order.adjustItem', reason: 'gaveup' })).toBe(
      'A saved change did not sync',
    );
  });

  test('an order change from a day that is over says so (CMP-FE-3, was OrderPage)', () => {
    expect(
      offlineDropText(t as never, {
        procedure: 'order.adjustItem',
        reason: 'rejected',
        message: 'order.errors.staleOfflineEdit',
      }),
    ).toBe('That day is over; the change was not saved');
  });
});
