import { beforeAll, describe, expect, test } from 'bun:test';
import { loadCatalog } from '@compass/i18n';
import { droppedWhat, offlineDropText, offlineDropToastOptions } from '../offlineDrop';
import { loggableInput } from '../outbox/engine';

// A reason is shown only when this build's catalog has its key (COREWEB2-19).
beforeAll(async () => {
  await loadCatalog('en');
});

const catalog: Record<string, string> = {
  'run.toast.syncFailed': 'A saved change did not sync',
  'offline.action.confirmStore': 'Confirm receipt',
  'offline.drop.withReason': '{action} did not sync: {reason}',
  'offline.drop.generic': '{action} did not sync — please check',
  'run.errors.storeItemsUnchecked': '2 lines still to check',
  'order.errors.staleOfflineEdit': 'That day is over; the change was not saved',
  'offline.drop.detail': 'It was: {what}.',
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

  test('a stale-version refusal also offers Refresh, first (UX-22)', () => {
    const onClick = () => {};
    const opts = offlineDropToastOptions('Got it', { label: 'Refresh', onClick });
    expect(opts.ttlMs).toBe(0);
    expect(opts.actions).toEqual([
      { label: 'Refresh', onClick, emphasis: 'primary' },
      { label: 'Got it' },
    ]);
  });
});

// Plan 2.4 (2026-11-23): ten purchases dropped after a run was finished
// were ten notices that named only the action; nobody could tell which
// to enter again.
describe('what a dropped write was', () => {
  const RICE = '00000000-0000-4000-8000-000000000001';
  const nameOf = (id: string) => (id === RICE ? 'Rice' : undefined);

  test('a purchase: the product, the quantity and the price', () => {
    expect(
      droppedWhat({ runId: 'r', skuId: RICE, actualQty: '4.500', unitPrice: '12000.00' }, nameOf),
    ).toBe('Rice 4.5 × 12,000');
  });

  test('a product the cached catalogue does not know still shows its numbers', () => {
    expect(
      droppedWhat(
        { skuId: '00000000-0000-4000-8000-000000000002', actualQty: '2', unitPrice: '5' },
        nameOf,
      ),
    ).toBe('2 × 5');
  });

  test('an order line and an expense', () => {
    expect(droppedWhat({ skuId: RICE, qty: '3' }, nameOf)).toBe('Rice 3');
    expect(droppedWhat({ label: 'Taxi', qty: '1', unitPrice: '30000' }, nameOf)).toBe(
      'Taxi 1 × 30,000',
    );
  });

  test('nothing worth showing: no detail', () => {
    expect(droppedWhat({ runId: 'r', storeId: 's' }, nameOf)).toBeNull();
    expect(droppedWhat(null, nameOf)).toBeNull();
  });

  test('the notice gets the detail as its own sentence', () => {
    expect(
      offlineDropText(t, { procedure: 'run.confirmStore', reason: 'gaveup' }, 'Rice 4 × 12,000'),
    ).toBe('Confirm receipt did not sync — please check It was: Rice 4 × 12,000.');
    expect(offlineDropText(t, { procedure: 'run.confirmStore', reason: 'gaveup' }, null)).toBe(
      'Confirm receipt did not sync — please check',
    );
  });
});

describe('a dropped write in the client log', () => {
  test('keeps the input but not a photo', () => {
    const photo = `data:image/jpeg;base64,${'A'.repeat(5000)}`;
    expect(
      loggableInput({
        skuId: 'x',
        actualQty: '2',
        receiptPhotoUrl: photo,
        storeSplits: [{ qty: '2' }],
      }),
    ).toEqual({
      skuId: 'x',
      actualQty: '2',
      receiptPhotoUrl: `[${photo.length} chars]`,
      storeSplits: [{ qty: '2' }],
    });
  });
});
