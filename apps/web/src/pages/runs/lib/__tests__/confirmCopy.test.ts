import { describe, expect, test } from 'bun:test';
import type { I18n } from '@compass/i18n';
import type { ActiveRun } from '../../types';
import { confirmCommandFor, confirmCopyFor, type ConfirmKind } from '../confirmCopy';
import { finishSummaryOf } from '../finishSummary';

/** Every text is its key, with its values when it has any. */
const i18n: I18n = {
  locale: 'en',
  t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
};

type Item = ActiveRun['items'][number];
type Split = ActiveRun['splits'][number];

const item = (skuId: string, over: Partial<Item> = {}): Item => ({
  skuId,
  plannedQty: '1',
  purchasedQty: '1',
  status: 'purchased',
  unavailableNote: null,
  unitPrice: '100',
  paymentMethod: 'cash',
  ...over,
});
const split = (skuId: string, storeId: string, qty: string, over: Partial<Split> = {}): Split => ({
  runId: 'run',
  skuId,
  storeId,
  qty,
  deliveredAt: null,
  confirmedAt: null,
  ...over,
});
const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  id: 'run',
  status: 'delivering',
  items: [],
  splits: [],
  ...over,
});

const NOW = Date.parse('2026-11-12T12:00:00Z');
const copy = (kind: ConfirmKind, r: ActiveRun | undefined = run()) =>
  confirmCopyFor(kind, {
    i18n,
    run: r,
    summary: finishSummaryOf(r, NOW),
    currency: 'UZS',
    storeName: (id) => `store:${id}`,
    skuName: (id) => `sku:${id}`,
  });

describe('confirmCommandFor', () => {
  test('the steps without a reason send the run alone', () => {
    for (const kind of ['startPurchase', 'startDelivery', 'finish', 'refinalize'] as const) {
      expect(confirmCommandFor(kind, 'r1', 'ignored')).toEqual({
        procedure: kind,
        input: { runId: 'r1' },
      });
    }
  });

  test('the undo steps and cancel send the reason typed', () => {
    expect(confirmCommandFor('cancel', 'r1', 'wrong day')).toEqual({
      procedure: 'cancelRun',
      input: { runId: 'r1', reason: 'wrong day' },
    });
    expect(confirmCommandFor('undoStartDelivery', 'r1', 'x')).toEqual({
      procedure: 'undoStartDelivery',
      input: { runId: 'r1', reason: 'x' },
    });
    expect(
      confirmCommandFor({ kind: 'recallDelivery', storeId: 's', storeName: 'S' }, 'r1', 'late'),
    ).toEqual({
      procedure: 'undeliverStore',
      input: { runId: 'r1', storeId: 's', reason: 'late' },
    });
    expect(
      confirmCommandFor({ kind: 'unmarkUnavailable', skuId: 'k', skuName: 'K' }, 'r1', 'found'),
    ).toEqual({
      procedure: 'unmarkUnavailable',
      input: { runId: 'r1', skuId: 'k', reason: 'found' },
    });
  });

  test('undoing a purchase and removing an expense ask for no reason', () => {
    expect(
      confirmCommandFor(
        { kind: 'undoPurchase', skuId: 'k', skuName: 'K', added: false },
        'r1',
        'typed',
      ),
    ).toEqual({ procedure: 'undoPurchase', input: { runId: 'r1', skuId: 'k', reason: '' } });
    expect(
      confirmCommandFor({ kind: 'removeExpense', expenseId: 'e', label: 'Taxi' }, 'r1', 'typed'),
    ).toEqual({ procedure: 'removeExpense', input: { runId: 'r1', expenseId: 'e', reason: '' } });
  });

  test('a session is ejected with its reason trimmed, or none', () => {
    const kind: ConfirmKind = {
      kind: 'ejectSession',
      sessionId: 'sess',
      storeName: 'S',
      submitterName: 'W',
    };
    expect(confirmCommandFor(kind, 'r1', '  late order ')).toEqual({
      procedure: 'ejectSession',
      input: { runId: 'r1', sessionId: 'sess', reason: 'late order' },
    });
    expect(confirmCommandFor(kind, 'r1', '   ').input).toEqual({
      runId: 'r1',
      sessionId: 'sess',
      reason: undefined,
    });
  });

  test('delivering to a store names the store', () => {
    expect(
      confirmCommandFor({ kind: 'deliverStore', storeId: 's', storeName: 'S' }, 'r1', ''),
    ).toEqual({ procedure: 'deliverToStore', input: { runId: 'r1', storeId: 's' } });
  });

  test('not buying a top-up names the item (RUNWEB1-29)', () => {
    expect(
      confirmCommandFor({ kind: 'dismissTopUp', skuId: 'k', qty: '2' }, 'r1', 'typed'),
    ).toEqual({ procedure: 'dismissTopUp', input: { runId: 'r1', skuId: 'k' } });
  });
});

describe('confirmCopyFor', () => {
  test('which steps ask for a reason, which are red, which lock the run', () => {
    const flags = (kind: ConfirmKind) => {
      const c = copy(kind);
      return [c.requireReason, c.reasonOptional ?? false, c.danger, c.irreversible ?? false];
    };
    expect(flags('startPurchase')).toEqual([false, false, false, false]);
    expect(flags('finish')).toEqual([false, false, false, true]);
    expect(flags('refinalize')).toEqual([false, false, false, true]);
    expect(flags('cancel')).toEqual([false, true, true, false]);
    expect(flags('undoStartPurchase')).toEqual([true, false, false, false]);
    expect(flags({ kind: 'recallDelivery', storeId: 's', storeName: 'S' })).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(flags({ kind: 'undoPurchase', skuId: 'k', skuName: 'K', added: true })).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(
      flags({ kind: 'ejectSession', sessionId: 's', storeName: 'S', submitterName: 'W' }),
    ).toEqual([false, true, true, false]);
  });

  test('not buying a top-up asks, with the quantity, in the run sheet (RUNWEB1-29)', () => {
    expect(copy({ kind: 'dismissTopUp', skuId: 'k', qty: '2.5' })).toEqual({
      title: 'run.topUp.dismiss',
      body: 'run.topUp.dismissConfirm {"qty":"2.5"}',
      confirmLabel: 'run.topUp.dismiss',
      danger: false,
      requireReason: false,
    });
  });

  test('undoing an added row says it is removed', () => {
    expect(copy({ kind: 'undoPurchase', skuId: 'k', skuName: 'K', added: true }).body).toBe(
      'run.confirm.undoPurchase.bodyAdded',
    );
    expect(copy({ kind: 'undoPurchase', skuId: 'k', skuName: 'K', added: false }).body).toBe(
      'run.confirm.undoPurchase.body',
    );
  });

  test('starting delivery warns about other items still not handled', () => {
    const body = copy(
      'startDelivery',
      run({
        sessionExtrasByStore: {
          A: [
            { name: 'Napkins', qty: '1', unit: 'pack' },
            { name: 'Ice', qty: '2', unit: 'kg', status: 'bought' },
            { name: 'Soap', qty: '1', unit: 'pcs' },
          ],
        },
      }),
    ).body;
    expect(body).toContain('run.confirm.startDelivery.body');
    // The names are a list in the screen's language (RUNWEB1-22).
    expect(body).toContain(
      'run.confirm.startDelivery.pendingExtras {"n":2,"names":"Napkinscommon.listSeparatorSoap"}',
    );
    expect(copy('startDelivery').body).toBe('run.confirm.startDelivery.body');
  });

  test('delivering says what the store gets', () => {
    const body = copy(
      { kind: 'deliverStore', storeId: 'A', storeName: 'Store A' },
      run({
        items: [item('tomato', { purchasedQty: '2' })],
        splits: [split('tomato', 'A', '2')],
        perStoreDemand: [{ storeId: 'A', skuId: 'tomato', qty: '2' }],
      }),
    ).body;
    expect(body).toBe(
      'run.label.itemsCount {"n":1} · ' +
        'common.labelValue {"label":"run.label.itemsTotal","value":"200 UZS"}\n' +
        'run.confirm.deliver.body',
    );
  });

  // RUNWEB1-08: the figures are rows, each said once; the text says what locks.
  test('the finish sheet: the text, and the total with its counts', () => {
    const c = copy('finish', run({ items: [item('tomato')], splits: [split('tomato', 'A', '1')] }));
    expect(c.body).toBe('run.confirm.finish.body');
    expect(c.summary).toEqual({
      rows: [
        {
          key: 'total',
          label: 'run.confirm.finish.counts {"items":1,"stores":1}',
          value: 'common.amountWithCurrency {"amount":"100","currency":"UZS"}',
        },
      ],
      notes: [],
      stores: [],
      receipt: null,
    });
  });

  test('the finish sheet: two stores, both methods, an added row, a short line', () => {
    const { summary } = copy(
      'finish',
      run({
        items: [
          item('tomato', { purchasedQty: '2' }),
          item('bread', { unitPrice: '30', paymentMethod: 'transfer', addedByPurchaser: true }),
        ],
        splits: [
          split('tomato', 'A', '1', { confirmStatus: 'short', confirmReceivedQty: '0.5' }),
          split('tomato', 'B', '1'),
          split('bread', 'B', '1'),
        ],
      }),
    );
    expect(summary?.rows).toEqual([
      {
        key: 'total',
        label: 'run.confirm.finish.counts {"items":2,"stores":2}',
        value: 'common.amountWithCurrency {"amount":"230","currency":"UZS"}',
      },
      { key: 'cash', label: 'run.label.paymentCash', value: '200' },
      { key: 'transfer', label: 'run.label.paymentTransfer', value: '30' },
      { key: 'added', label: 'run.confirm.finish.addedCount {"n":1}', value: '30' },
    ]);
    // Largest bill first; a store's two parts only when it paid both ways.
    expect(summary?.stores).toEqual([
      {
        storeId: 'B',
        name: 'store:B',
        total: '130',
        paidBoth: 'run.money.cashTransfer {"cash":"100","transfer":"30"}',
      },
      { storeId: 'A', name: 'store:A', total: '100', paidBoth: null },
    ]);
    expect(summary?.receipt).toEqual({
      summary: 'run.confirm.finish.receiptIssues {"n":1,"amount":"50","currency":"UZS"}',
      lines: [
        'run.confirm.finish.receiptIssueLine {"sku":"sku:tomato","store":"store:A","received":"0.5","qty":"1"}',
      ],
      more: null,
    });
    expect(summary?.notes).toEqual([]);
  });

  test("the finish sheet: expenses are the total's second part, said once", () => {
    const { summary } = copy(
      'finish',
      run({
        items: [item('tomato')],
        splits: [split('tomato', 'A', '1')],
        expenses: [
          {
            id: 'taxi',
            label: 'Taxi',
            unitHint: null,
            qty: '1',
            unitPrice: '40',
            storeSplits: [{ storeId: 'A', qty: '1' }],
            paymentMethod: 'cash',
            receiptPhotoUrl: null,
            reason: '',
            addedByMemberId: 'm',
            addedAt: '2026-11-12T08:00:00Z',
          },
        ],
        // The server's figures win over the sums here (CA-11).
        money: { itemsTotal: '100', expensesTotal: '50', total: '150' },
      }),
    );
    expect(summary?.rows).toEqual([
      {
        key: 'total',
        label: 'run.confirm.finish.counts {"items":1,"stores":1}',
        value: 'common.amountWithCurrency {"amount":"150","currency":"UZS"}',
      },
      { key: 'items', label: 'run.label.itemsTotal', value: '100' },
      { key: 'expenses', label: 'run.confirm.finish.expensesCount {"n":1}', value: '50' },
    ]);
  });

  test('the finish sheet: prices carried over from the last trip, and how many were old', () => {
    const { summary } = copy(
      'finish',
      run({
        items: [item('tomato'), item('onion', { unitPrice: '20' })],
        splits: [split('tomato', 'A', '1'), split('onion', 'A', '1')],
        lastPriceBySku: { tomato: '100', onion: '20.00' },
        lastPriceObservedAtBySku: {
          tomato: '2026-11-11T12:00:00Z',
          onion: '2026-10-01T12:00:00Z',
        },
      }),
    );
    expect(summary?.notes).toEqual([
      'run.finish.carriedOver {"n":2}',
      'run.finish.carriedOverStale {"n":1,"days":7}',
    ]);
  });

  test('the finish sheet lists five short lines and counts the rest', () => {
    const splits = Array.from({ length: 7 }, (_, i) =>
      split('tomato', `S${i}`, '1', { confirmStatus: 'short', confirmReceivedQty: '0' }),
    );
    const { summary } = copy(
      'finish',
      run({ items: [item('tomato', { purchasedQty: '7' })], splits }),
    );
    expect(summary?.receipt?.lines).toHaveLength(5);
    expect(summary?.receipt?.more).toBe('run.confirm.finish.receiptIssuesMore {"n":2}');
  });

  test('closing a correction shows the same money rows, nothing else', () => {
    const c = copy(
      'refinalize',
      run({
        status: 'amending',
        items: [item('tomato')],
        splits: [split('tomato', 'A', '1', { confirmStatus: 'short', confirmReceivedQty: '0' })],
        money: { itemsTotal: '100', expensesTotal: '0', total: '100' },
      }),
    );
    expect(c.body).toBe('run.confirm.refinalize.body');
    expect(c.summary).toEqual({
      rows: [
        {
          key: 'total',
          label: 'run.confirm.finish.counts {"items":1,"stores":1}',
          value: 'common.amountWithCurrency {"amount":"100","currency":"UZS"}',
        },
      ],
      notes: [],
      stores: [],
      receipt: null,
    });
  });
});
