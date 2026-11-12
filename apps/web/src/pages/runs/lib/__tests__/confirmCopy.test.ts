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
          ],
        },
      }),
    ).body;
    expect(body).toContain('run.confirm.startDelivery.body');
    expect(body).toContain('run.confirm.startDelivery.pendingExtras {"n":1,"names":"Napkins"}');
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
      'run.label.itemsCount {"n":1} · run.label.itemsTotal 200 UZS\nrun.confirm.deliver.body',
    );
  });

  test('the finish body: summary, money, and only the lines that apply', () => {
    const plain = copy(
      'finish',
      run({ items: [item('tomato')], splits: [split('tomato', 'A', '1')] }),
    ).body.split('\n');
    expect(plain).toEqual([
      'run.confirm.finish.body',
      '',
      'run.confirm.finish.summary {"items":1,"stores":1,"total":"100","currency":"UZS"}',
      'run.confirm.finish.money {"items":"100","expenses":"0","total":"100","currency":"UZS"}',
    ]);
  });

  test('the finish body: two stores, both methods, an added row, a short line', () => {
    const body = copy(
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
    ).body;
    expect(body).toContain('run.confirm.finish.paymentBreakdown {"cash":"200","transfer":"30"}');
    expect(body).toContain(
      'run.confirm.finish.addedByPurchaser {"n":1,"total":"30","currency":"UZS"}',
    );
    expect(body).toContain(
      '\n\nrun.confirm.finish.perStoreHeading\n' +
        'common.labelValue {"label":"store:B","value":"130 · run.label.paymentCash 100 · run.label.paymentTransfer 30"}\n' +
        'common.labelValue {"label":"store:A","value":"100"}',
    );
    expect(body).toContain(
      '\n\nrun.confirm.finish.receiptIssues {"n":1,"amount":"50","currency":"UZS"}\n' +
        'run.confirm.finish.receiptIssueLine {"sku":"sku:tomato","store":"store:A","received":"0.5","qty":"1"}',
    );
    expect(body).not.toContain('run.confirm.finish.expenses');
    expect(body).not.toContain('run.finish.carriedOver');
  });

  test('the finish body lists five short lines and counts the rest', () => {
    const splits = Array.from({ length: 7 }, (_, i) =>
      split('tomato', `S${i}`, '1', { confirmStatus: 'short', confirmReceivedQty: '0' }),
    );
    const lines = copy('finish', run({ items: [item('tomato', { purchasedQty: '7' })], splits }))
      .body.split('\n')
      .filter((l) => l.startsWith('run.confirm.finish.receiptIssue'));
    expect(lines.filter((l) => l.startsWith('run.confirm.finish.receiptIssueLine'))).toHaveLength(
      5,
    );
    expect(lines.at(-1)).toBe('run.confirm.finish.receiptIssuesMore {"n":2}');
  });
});
