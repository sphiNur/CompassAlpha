import { describe, expect, test } from 'bun:test';
import {
  daysOld,
  groupSessionsByDate,
  selectPreview,
  selectedSessionIds,
  withGroupSelection,
} from '../sessionSelection';

const TODAY = '2026-10-21';
const sessions = [
  { id: 's-old', storeId: 'A', storeName: 'Alpha', orderDate: '2026-10-19', notes: 'old note' },
  { id: 's-a', storeId: 'A', storeName: 'Alpha', orderDate: TODAY, notes: null },
  { id: 's-b', storeId: 'B', storeName: 'Beta', orderDate: TODAY, notes: 'beta note' },
];

describe('session selection (CA-03)', () => {
  test("only today's sessions are ticked by default", () => {
    expect(selectedSessionIds(sessions, TODAY, new Map())).toEqual(['s-a', 's-b']);
  });

  test('without a server today nothing is preselected', () => {
    expect(selectedSessionIds(sessions, null, new Map())).toEqual([]);
  });

  test('overrides tick an old session or untick a today one', () => {
    const o = new Map([
      ['s-old', true],
      ['s-b', false],
    ]);
    expect(selectedSessionIds(sessions, TODAY, o)).toEqual(['s-old', 's-a']);
  });

  test('groups newest date first and flags today', () => {
    const groups = groupSessionsByDate(sessions, TODAY);
    expect(groups.map((g) => [g.date, g.isToday, g.sessions.length])).toEqual([
      [TODAY, true, 2],
      ['2026-10-19', false, 1],
    ]);
  });

  test('a group toggle sets every session in the group', () => {
    const [, old] = groupSessionsByDate(sessions, TODAY);
    const o = withGroupSelection(new Map(), old!, true);
    expect(selectedSessionIds(sessions, TODAY, o)).toEqual(['s-old', 's-a', 's-b']);
  });

  test('daysOld', () => {
    expect(daysOld('2026-10-19', TODAY)).toBe(2);
    expect(daysOld(TODAY, TODAY)).toBe(0);
    expect(daysOld('2026-10-19', null)).toBe(0);
  });

  test('selectPreview re-aggregates demand, budgets, notes and extras over the ticked sessions', () => {
    const preview = {
      date: null,
      sessions,
      plannedItems: [{ skuId: 'k1', qty: '6' }],
      perStoreDemand: [
        { storeId: 'A', storeName: 'Alpha', skuId: 'k1', qty: '5' },
        { storeId: 'B', storeName: 'Beta', skuId: 'k1', qty: '1' },
      ],
      perSessionDemand: [
        { sessionId: 's-old', skuId: 'k1', qty: '3' },
        { sessionId: 's-a', skuId: 'k1', qty: '2' },
        { sessionId: 's-b', skuId: 'k1', qty: '1' },
        { sessionId: 's-b', skuId: 'k2', qty: '4' },
      ],
      supplierBySku: { k1: null, k2: null },
      lastPurchasePriceBySku: { k1: '100' },
      sessionExtrasByStore: {
        A: [
          { name: 'x', qty: '1', unit: 'pc', sessionId: 's-old', idx: 0 },
          { name: 'y', qty: '1', unit: 'pc', sessionId: 's-a', idx: 0 },
        ],
      },
    };
    const out = selectPreview(preview, ['s-a', 's-b']);
    expect(out.sessions.map((s) => s.id)).toEqual(['s-a', 's-b']);
    expect(out.plannedItems).toEqual([
      { skuId: 'k1', qty: '3' },
      { skuId: 'k2', qty: '4' },
    ]);
    expect(out.perStoreDemand.find((d) => d.storeId === 'A')?.qty).toBe('2');
    const budgetB = out.perStoreBudgets?.find((b) => b.storeId === 'B');
    expect(budgetB).toMatchObject({ estimatedTotal: '100.00', unknownPriceCount: 1 });
    expect(out.sessionNotesByStore).toEqual({ B: 'beta note' });
    expect(out.sessionExtrasByStore?.A?.map((e) => e.sessionId)).toEqual(['s-a']);
  });

  test('an old server without perSessionDemand gets the preview back unchanged', () => {
    const preview = {
      sessions,
      plannedItems: [{ skuId: 'k1', qty: '6' }],
      perStoreDemand: [],
      supplierBySku: {},
    };
    expect(selectPreview(preview, [])).toBe(preview);
  });
});
