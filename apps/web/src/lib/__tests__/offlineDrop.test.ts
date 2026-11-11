import { describe, expect, test } from 'bun:test';
import { offlineDropText, offlineDropToastOptions } from '../offlineDrop';

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
      offlineDropText(t, {
        procedure: 'run.confirmStore',
        reason: 'rejected',
        message: 'run.errors.storeItemsUnchecked',
      }),
    ).toBe('Confirm receipt did not sync: 2 lines still to check');
  });

  test('a reason that ends with a full stop does not end the sentence twice (I18N1-20)', () => {
    // The real templates close the reason's sentence themselves.
    const from =
      (cat: Record<string, string>) => (key: string, values?: Record<string, string | number>) =>
        (cat[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
    const info = {
      procedure: 'run.confirmStore',
      reason: 'rejected',
      message: 'run.errors.alreadyFinished',
    } as const;
    const en = from({
      'offline.action.confirmStore': 'Confirm receipt',
      'offline.drop.withReason':
        '"{action}" was not sent: {reason}. Open it and redo it if needed.',
      'run.errors.alreadyFinished': 'Run is already finished.',
    });
    expect(offlineDropText(en, info)).toBe(
      '"Confirm receipt" was not sent: Run is already finished. Open it and redo it if needed.',
    );
    const zh = from({
      'offline.action.confirmStore': '确认收货',
      'offline.drop.withReason': '「{action}」没发出去：{reason}。打开看看，需要的话重新录一次。',
      'run.errors.alreadyFinished': '采购单已完成。',
    });
    expect(offlineDropText(zh, info)).toBe(
      '「确认收货」没发出去：采购单已完成。打开看看，需要的话重新录一次。',
    );
  });

  test('without a known reason, the action alone', () => {
    expect(
      offlineDropText(t, {
        procedure: 'run.confirmStore',
        reason: 'rejected',
        message: 'run.errors.somethingUnknown',
      }),
    ).toBe('Confirm receipt did not sync — please check');
    expect(offlineDropText(t, { procedure: 'run.confirmStore', reason: 'gaveup' })).toBe(
      'Confirm receipt did not sync — please check',
    );
  });

  test('a procedure this page does not know keeps the generic copy', () => {
    expect(offlineDropText(t, { procedure: 'order.adjustItem', reason: 'gaveup' })).toBe(
      'A saved change did not sync',
    );
  });

  test('an order change from a day that is over says so (CMP-FE-3, was OrderPage)', () => {
    expect(
      offlineDropText(t, {
        procedure: 'order.adjustItem',
        reason: 'rejected',
        message: 'order.errors.staleOfflineEdit',
      }),
    ).toBe('That day is over; the change was not saved');
  });
});

describe('the dropped-write toast stays (DX-DLV-06)', () => {
  test('no timeout, dismissed with an explicit button', () => {
    const opts = offlineDropToastOptions('Got it');
    expect(opts.ttlMs).toBe(0);
    expect(opts.actions).toEqual([{ label: 'Got it' }]);
  });
});
