import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun } from './index';
import { computeRunTotals } from './commands';
import { fixedClock } from '../shared/clock';
import { RUN_CLOCK as clock, RUN_NOW as NOW, confirmStoreAllOk, planAndPurchase, purchaser, runActor, runStepper } from '../testing';

const { step } = runStepper(clock);

// 2026-10-21 CA-11: FinishRun / RefinalizeRun carry items and expenses
// explicitly; totalActual keeps its items-only meaning.
describe('run.totals', () => {
  const finishWith = () => {
    // sku-1: 4 × 12,000 with a per-store override on B (2 @ 15,000).
    let s = planAndPurchase({
      storeSplits: [
        { storeId: 'A', qty: '2' },
        { storeId: 'B', qty: '2', unitPrice: '15000', paymentMethod: 'transfer' },
      ],
    });
    s = step(s, {
      type: 'AddRunExpense',
      expenseId: 'ex-1',
      label: 'porter',
      qty: '1',
      unitPrice: '5000',
      storeSplits: [
        { storeId: 'A', qty: '0.5' },
        { storeId: 'B', qty: '0.5' },
      ],
      paymentMethod: 'cash',
      receiptPhotoUrl: null,
      reason: 'carry',
      actor: purchaser(),
    });
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    for (const storeId of ['A', 'B']) {
      s = step(s, { type: 'DeliverToStore', storeId, actor: purchaser() });
      s = confirmStoreAllOk(s, storeId);
    }
    return s;
  };

  test('FinishRun emits itemsTotal (with per-store overrides) and expensesTotal', () => {
    const evs = decideRun(finishWith(), { type: 'FinishRun', actor: purchaser() }, clock);
    const ev = evs[0];
    if (ev?.type !== 'RunFinished') throw new Error('expected RunFinished');
    // 2 × 12,000 + 2 × 15,000 = 54,000 items; 5,000 expenses.
    expect(ev.payload.totalActual).toBe('54000.00');
    expect(ev.payload.itemsTotal).toBe('54000.00');
    expect(ev.payload.expensesTotal).toBe('5000.00');
    expect(ev.payload.totalCash).toBe('24000.00');
    expect(ev.payload.totalTransfer).toBe('30000.00');
  });

  test('D1: each store line is rounded half-up to cents, totals add the cents', () => {
    // 0.5 × 2.01 = 1.005 and 0.5 × 4.03 = 2.015: float math froze 1.00 /
    // 2.01; the report (per-line ROUND) says 1.01 / 2.02.
    let s = planAndPurchase({
      purchasedQty: '1',
      storeSplits: [
        { storeId: 'A', qty: '0.5', unitPrice: '2.01' },
        { storeId: 'B', qty: '0.5', unitPrice: '4.03', paymentMethod: 'transfer' },
      ],
    });
    s = step(s, {
      type: 'AddRunExpense',
      expenseId: 'ex-1',
      label: 'porter',
      qty: '1',
      unitPrice: '2.01',
      storeSplits: [
        { storeId: 'A', qty: '0.5' },
        { storeId: 'B', qty: '0.5' },
      ],
      paymentMethod: 'cash',
      receiptPhotoUrl: null,
      reason: 'carry',
      actor: purchaser(),
    });
    expect(computeRunTotals(s)).toEqual({
      total: '3.03',
      totalCash: '1.01',
      totalTransfer: '2.02',
      // Two expense lines of 1.005 → 1.01 each.
      expensesTotal: '2.02',
    });
  });

  test('RefinalizeRun re-freezes the same items / expenses split', () => {
    const amender = runActor('sa', ['run.purchase', 'run.amend', 'run.finish']);
    let s = finishWith();
    s = step(s, { type: 'FinishRun', actor: purchaser() });
    s = step(s, { type: 'ReopenRun', reason: 'fix', actor: amender });
    s = step(s, { type: 'RemoveRunExpense', expenseId: 'ex-1', reason: 'dup', actor: amender });
    const ev = decideRun(s, { type: 'RefinalizeRun', actor: amender }, clock)[0];
    if (ev?.type !== 'RunRefinalized') throw new Error('expected RunRefinalized');
    expect(ev.payload.itemsTotal).toBe('54000.00');
    expect(ev.payload.expensesTotal).toBe('0.00');
    expect(ev.payload.totalActual).toBe('54000.00');
  });

  test('closing a correction keeps the time the run finished (DLV-15)', () => {
    const amender = runActor('sa', ['run.purchase', 'run.amend', 'run.finish']);
    let s = finishWith();
    s = step(s, { type: 'FinishRun', actor: purchaser() });
    const finishedAt = s.finishedAt;
    expect(finishedAt).toEqual(NOW);
    const later = fixedClock(new Date(NOW.getTime() + 3_600_000));
    s = decideRun(s, { type: 'ReopenRun', reason: 'fix', actor: amender }, later).reduce(
      applyRun,
      s,
    );
    s = decideRun(s, { type: 'RefinalizeRun', actor: amender }, later).reduce(applyRun, s);
    expect(s.status).toBe('finished');
    expect(s.finishedAt).toEqual(finishedAt);
  });
});
