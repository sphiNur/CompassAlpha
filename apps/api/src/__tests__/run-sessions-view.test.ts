/**
 * Review RUNAPI-14: the order sessions behind a run, as run.get,
 * run.historyDetail and run.previewCreatable now all build them
 * (services/runSessionsView.ts). Pure parts only — runs everywhere.
 */
import { describe, expect, test } from 'bun:test';
import {
  notesAndExtrasByStore,
  senderName,
  sessionDemand,
  storedExtras,
} from '../services/runSessionsView';

const A = 'store-a';
const B = 'store-b';

function session(id: string, storeId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    storeId,
    notes: null as string | null,
    extrasJson: [] as unknown,
    lastSeq: 3,
    ...over,
  };
}

describe('storedExtras', () => {
  test('an array is the list; anything else reads as none', () => {
    const extras = [{ name: 'Foil', qty: '1', unit: 'pack' }];
    expect(storedExtras(extras)).toEqual(extras);
    expect(storedExtras(null)).toEqual([]);
    expect(storedExtras({ name: 'Foil' })).toEqual([]);
  });
});

describe('notesAndExtrasByStore', () => {
  test("joins each store's notes and lists its extras with their place", () => {
    const out = notesAndExtrasByStore([
      session('s1', A, {
        notes: '  call first  ',
        extrasJson: [
          { name: 'Foil', qty: '1', unit: 'pack' },
          { name: 'Ice', qty: '2', unit: 'kg', status: 'bought' },
        ],
      }),
      session('s2', A, {
        notes: 'back door',
        lastSeq: 7,
        extrasJson: [{ name: 'Gloves', qty: '1', unit: 'pack' }],
      }),
      session('s3', B, { notes: '   ' }),
    ]);
    expect(out.sessionNotesByStore).toEqual({ [A]: 'call first\n\nback door' });
    expect(out.sessionExtrasByStore).toEqual({
      [A]: [
        { name: 'Foil', qty: '1', unit: 'pack', sessionId: 's1', idx: 0, sessionSeq: 3 },
        {
          name: 'Ice',
          qty: '2',
          unit: 'kg',
          status: 'bought',
          sessionId: 's1',
          idx: 1,
          sessionSeq: 3,
        },
        { name: 'Gloves', qty: '1', unit: 'pack', sessionId: 's2', idx: 0, sessionSeq: 7 },
      ],
    });
  });

  test('a store with neither notes nor extras is left out', () => {
    expect(notesAndExtrasByStore([session('s1', A)])).toEqual({
      sessionNotesByStore: {},
      sessionExtrasByStore: {},
    });
  });
});

describe('senderName', () => {
  const names = new Map([
    ['m-submit', 'Dilnoza'],
    ['m-start', 'Bekzod'],
  ]);

  test('the submitter, else whoever started the session', () => {
    expect(
      senderName(names, { submittedByMemberId: 'm-submit', initiatedByMemberId: 'm-start' }),
    ).toBe('Dilnoza');
    expect(senderName(names, { submittedByMemberId: null, initiatedByMemberId: 'm-start' })).toBe(
      'Bekzod',
    );
  });

  test('null when nobody is named or the name is unknown', () => {
    expect(senderName(names, { submittedByMemberId: null, initiatedByMemberId: null })).toBeNull();
    expect(
      senderName(names, { submittedByMemberId: 'm-gone', initiatedByMemberId: null }),
    ).toBeNull();
  });
});

describe('sessionDemand', () => {
  const sessions = [
    { id: 's1', storeId: A },
    { id: 's2', storeId: A },
    { id: 's3', storeId: B },
  ];

  test('adds per store and product, exactly', () => {
    const { perStoreDemand } = sessionDemand(sessions, [
      { sessionId: 's1', skuId: 'tomato', qty: '0.1' },
      { sessionId: 's2', skuId: 'tomato', qty: '0.2' },
      { sessionId: 's3', skuId: 'tomato', qty: '1' },
      { sessionId: 's1', skuId: 'onion', qty: '2.500' },
    ]);
    expect(perStoreDemand).toEqual([
      { storeId: A, skuId: 'tomato', qty: '0.3' },
      { storeId: B, skuId: 'tomato', qty: '1' },
      { storeId: A, skuId: 'onion', qty: '2.5' },
    ]);
  });

  test('a product two people put in one session counts once', () => {
    const { bySession } = sessionDemand(sessions, [
      { sessionId: 's1', skuId: 'tomato', qty: '1' },
      { sessionId: 's1', skuId: 'tomato', qty: '2' },
      { sessionId: 's1', skuId: 'onion', qty: '0.5' },
    ]);
    expect(bySession.get('s1')).toEqual({ itemCount: 2, totalQty: '3.5' });
  });

  test("leaves out zero lines and other sessions' lines", () => {
    const { perStoreDemand, bySession } = sessionDemand(sessions, [
      { sessionId: 's1', skuId: 'tomato', qty: '0' },
      { sessionId: 'elsewhere', skuId: 'tomato', qty: '4' },
    ]);
    expect(perStoreDemand).toEqual([]);
    expect(bySession.size).toBe(0);
  });
});
