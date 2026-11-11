/**
 * 2026-10-21 CA-04 / CA-06: which delivering run a store confirms, and
 * the received-qty rule on problem lines.
 */
import { describe, it, expect } from 'bun:test';
import { setDecimalLocale } from '@compass/ui';
import {
  checkReceivedQty,
  confirmMainButton,
  defaultDeliveringRunId,
  deliveringRunsForStore,
  initialReceivedQty,
  issueFormCheck,
  issueSaveState,
  receivingWait,
  runsListView,
  sameLine,
  unboughtForStore,
  withLineVerdict,
  type ConfirmMainButtonState,
  type IssueFormFields,
} from '../confirmLogic';

const run = (
  id: string,
  runDate: string,
  runIndex: number,
  status = 'delivering',
  stores: string[] = ['A'],
) => ({
  id,
  status,
  runDate,
  runIndex,
  storeTotals: stores.map((storeId) => ({ storeId, itemCount: 2 })),
});

describe('deliveringRunsForStore', () => {
  it('keeps only delivering runs with goods for the store, oldest first', () => {
    const rows = [
      run('r3', '2026-10-21', 0, 'delivering', ['A']),
      run('r2', '2026-10-20', 1, 'delivering', ['A', 'B']),
      run('r1', '2026-10-20', 0, 'delivering', ['B']),
      run('r0', '2026-10-19', 0, 'finished', ['A']),
      run('rp', '2026-10-21', 1, 'purchasing', ['A']),
    ];
    expect(deliveringRunsForStore(rows, 'A').map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(deliveringRunsForStore(rows, 'B').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('falls back to the first delivering run when none has goods for the store', () => {
    const rows = [run('r2', '2026-10-21', 0), run('r1', '2026-10-20', 0)];
    expect(deliveringRunsForStore(rows, 'Z').map((r) => r.id)).toEqual(['r1']);
    expect(deliveringRunsForStore([], 'A')).toEqual([]);
  });
});

describe('defaultDeliveringRunId', () => {
  const c = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  it('picks the oldest run the store has not signed for', () => {
    expect(defaultDeliveringRunId(c, new Map([['r1', true]]))).toBe('r2');
    expect(defaultDeliveringRunId(c, new Map())).toBe('r1');
  });
  it('falls back to the oldest when all are signed, null when none', () => {
    const all = new Map([
      ['r1', true],
      ['r2', true],
      ['r3', true],
    ]);
    expect(defaultDeliveringRunId(c, all)).toBe('r1');
    expect(defaultDeliveringRunId([], new Map())).toBeNull();
  });
});

describe('checkReceivedQty', () => {
  it('ok sends nothing', () => {
    expect(checkReceivedQty('ok', '5', '2')).toEqual({ ok: true, value: null });
  });
  it('short requires a value from 0 to below the split', () => {
    expect(checkReceivedQty('short', '', '2')).toEqual({ ok: false, reason: 'required' });
    expect(checkReceivedQty('short', '1,5', '2')).toEqual({ ok: true, value: '1.5' });
    expect(checkReceivedQty('short', '2', '2')).toEqual({ ok: false, reason: 'notShort' });
    expect(checkReceivedQty('short', '2.5', '2')).toEqual({ ok: false, reason: 'exceeds' });
    expect(checkReceivedQty('short', '-1', '2')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkReceivedQty('short', '1.2345', '2')).toEqual({ ok: false, reason: 'tooPrecise' });
  });
  it('R2-DLV-2: reads "1,000" by the interface language, like every number field', () => {
    try {
      setDecimalLocale('zh');
      // A thousand of a 6 l split is more than arrived — not a silent 1.
      expect(checkReceivedQty('short', '1,000', '6')).toEqual({ ok: false, reason: 'exceeds' });
      expect(checkReceivedQty('short', '4,5', '6')).toEqual({ ok: true, value: '4.5' });
      setDecimalLocale('ru');
      expect(checkReceivedQty('short', '1,000', '6')).toEqual({ ok: true, value: '1.000' });
      expect(checkReceivedQty('short', '1e0', '6')).toEqual({ ok: false, reason: 'invalid' });
      expect(checkReceivedQty('short', '1.2.3', '6')).toEqual({ ok: false, reason: 'invalid' });
    } finally {
      setDecimalLocale(null);
    }
  });
  it('wrong / quality default to 0', () => {
    expect(checkReceivedQty('wrong', '', '2')).toEqual({ ok: true, value: '0' });
    expect(checkReceivedQty('quality', '1', '2')).toEqual({ ok: true, value: '1' });
  });
});

describe('initialReceivedQty', () => {
  it('prefills the delivered qty for wrong/quality, empty for short, keeps an existing value', () => {
    expect(initialReceivedQty('short', null, '4.5')).toBe('');
    expect(initialReceivedQty('wrong', undefined, '4.500')).toBe('4.5');
    expect(initialReceivedQty('quality', null, '3')).toBe('3');
    expect(initialReceivedQty('quality', null)).toBe('0');
    expect(initialReceivedQty('quality', '1', '3')).toBe('1');
    expect(initialReceivedQty('short', '1.5', '4.5')).toBe('1.5');
  });
  it('DX-DLV-07: drops the trailing zeros the server keeps', () => {
    expect(initialReceivedQty('short', '5.000')).toBe('5');
    expect(initialReceivedQty('short', '1.500')).toBe('1.5');
    expect(initialReceivedQty('short', '10')).toBe('10');
  });
});

describe('runsListView (2026-10-21 FE-01 / F4-02)', () => {
  it('offline with nothing saved is offline, not "nothing to confirm" (R2-ENG-1)', () => {
    expect(
      runsListView({ isLoading: false, isError: false, hasData: false, waitingOffline: true }),
    ).toEqual({ kind: 'offline' });
    expect(
      runsListView({ isLoading: false, isError: false, hasData: true, waitingOffline: true }),
    ).toEqual({ kind: 'ready', stale: false });
  });
  it('first load is loading, not "nothing to confirm"', () => {
    expect(runsListView({ isLoading: true, isError: false, hasData: false })).toEqual({
      kind: 'loading',
    });
  });
  it('a failure with nothing cached is an error, not empty', () => {
    expect(runsListView({ isLoading: false, isError: true, hasData: false })).toEqual({
      kind: 'error',
    });
  });
  it('cached runs survive a failed refetch, flagged stale', () => {
    expect(runsListView({ isLoading: false, isError: true, hasData: true })).toEqual({
      kind: 'ready',
      stale: true,
    });
  });
  it('loaded data is ready', () => {
    expect(runsListView({ isLoading: false, isError: false, hasData: true })).toEqual({
      kind: 'ready',
      stale: false,
    });
  });
});

describe('issueSaveState (CMP-DLV-6)', () => {
  it('Save waits while the photo uploads, and says why', () => {
    expect(issueSaveState({ reasonOk: true, photoUploading: true, saving: false })).toEqual({
      canSave: false,
      waitingForPhoto: true,
    });
    expect(issueSaveState({ reasonOk: true, photoUploading: false, saving: false })).toEqual({
      canSave: true,
      waitingForPhoto: false,
    });
  });

  it('the other gates still hold', () => {
    expect(issueSaveState({ reasonOk: false, photoUploading: false, saving: false }).canSave).toBe(
      false,
    );
    expect(issueSaveState({ reasonOk: true, photoUploading: false, saving: true }).canSave).toBe(
      false,
    );
  });
});

describe('DX-DLV-13: the store sees what is coming', () => {
  it('a run naming its stores keeps an unbought-only store and drops others', () => {
    const rows = [
      { id: 'r1', status: 'delivering', runDate: '2026-11-01', runIndex: 0, storeTotals: [], storeIds: ['A'] },
    ];
    expect(deliveringRunsForStore(rows, 'A').map((r) => r.id)).toEqual(['r1']);
    expect(deliveringRunsForStore(rows, 'B')).toEqual([]);
  });

  it('tells recalled, on the way, being bought and nothing apart', () => {
    const runs = [{ status: 'purchasing', storeIds: ['A'] }];
    expect(receivingWait({ storeId: 'A', runs, active: { recalledStoreIds: ['A'] } })).toBe('recalled');
    expect(receivingWait({ storeId: 'A', runs, active: { recalledStoreIds: [] } })).toBe('onTheWay');
    expect(receivingWait({ storeId: 'A', runs, active: null })).toBe('buying');
    expect(receivingWait({ storeId: 'B', runs, active: null })).toBe('nothing');
  });

  it('lists the products not found for this store, with what it ordered', () => {
    const items = [
      { skuId: 's1', status: 'unavailable', unavailableNote: 'sold out' },
      { skuId: 's2', status: 'purchased', unavailableNote: null },
      { skuId: 's3', status: 'unavailable', unavailableNote: null },
    ];
    const demand = [
      { storeId: 'A', skuId: 's1', qty: '2' },
      { storeId: 'A', skuId: 's2', qty: '1' },
      { storeId: 'B', skuId: 's3', qty: '4' },
    ];
    expect(unboughtForStore(items, demand, 'A')).toEqual([
      { skuId: 's1', status: 'unavailable', unavailableNote: 'sold out', orderedQty: '2' },
    ]);
  });
});

describe('issueFormCheck (review CONF-07)', () => {
  const form = (patch: Partial<IssueFormFields> = {}): IssueFormFields => ({
    status: 'short',
    splitQty: '2',
    note: '',
    received: '',
    receivedTouched: false,
    saveTried: false,
    ...patch,
  });
  const idle = { photoUploading: false, saving: false };

  it('a fresh form shows no errors but cannot be saved, and says why', () => {
    expect(issueFormCheck(form(), idle)).toEqual({
      received: { ok: false, reason: 'required' },
      shownReceivedProblem: null,
      noteMissing: true,
      noteMissingShown: false,
      canSave: false,
      waitingForPhoto: false,
      saveBlockedBy: 'note',
    });
  });

  it('DX-DLV-07: the quantity error shows once the field was used, every error once Save was tried', () => {
    expect(issueFormCheck(form({ received: '3', receivedTouched: true }), idle)).toMatchObject({
      shownReceivedProblem: 'exceeds',
      noteMissingShown: false,
    });
    expect(issueFormCheck(form({ saveTried: true }), idle)).toMatchObject({
      shownReceivedProblem: 'required',
      noteMissingShown: true,
    });
  });

  it('a note and a valid quantity can be saved; a blank note is still missing', () => {
    expect(issueFormCheck(form({ note: 'two missing', received: '1,5' }), idle)).toMatchObject({
      received: { ok: true, value: '1.5' },
      canSave: true,
      saveBlockedBy: null,
    });
    expect(issueFormCheck(form({ note: '   ', received: '1' }), idle)).toMatchObject({
      noteMissing: true,
      canSave: false,
    });
    // A wrong item starts at the delivered quantity, which is valid.
    expect(
      issueFormCheck(form({ status: 'wrong', note: 'beef, not lamb', received: '2' }), idle)
        .canSave,
    ).toBe(true);
  });

  it('CMP-DLV-6: Save waits for the photo, and the photo is the reason given', () => {
    expect(
      issueFormCheck(form({ note: 'x', received: '1' }), { photoUploading: true, saving: false }),
    ).toMatchObject({
      canSave: false,
      waitingForPhoto: true,
      saveBlockedBy: 'photo',
    });
    expect(issueFormCheck(form(), { photoUploading: true, saving: false }).saveBlockedBy).toBe(
      'photo',
    );
  });

  it('cannot be saved twice while the first save is on its way', () => {
    expect(
      issueFormCheck(form({ note: 'x', received: '1' }), { photoUploading: false, saving: true }),
    ).toMatchObject({
      canSave: false,
      saveBlockedBy: null,
    });
  });
});

describe('sameLine / withLineVerdict (review CONF-07)', () => {
  const line = (skuId: string, storeId = 'A') => ({
    runId: 'r1',
    skuId,
    storeId,
    qty: '2',
    confirmStatus: null as string | null,
    confirmNote: null as string | null,
    confirmPhotoUrl: null as string | null,
    confirmReceivedQty: null as string | null,
  });

  it('a line is named by run, product and store', () => {
    const a = { runId: 'r1', skuId: 's1', storeId: 'A' };
    expect(sameLine(a, { ...a })).toBe(true);
    expect(sameLine(a, { ...a, runId: 'r2' })).toBe(false);
    expect(sameLine(a, { ...a, skuId: 's2' })).toBe(false);
    expect(sameLine(a, { ...a, storeId: 'B' })).toBe(false);
  });

  it('puts the verdict on its line only, without changing the list it was given', () => {
    const splits = [line('s1'), line('s2'), line('s1', 'B')];
    const next = withLineVerdict(splits, {
      runId: 'r1',
      skuId: 's1',
      storeId: 'A',
      status: 'short',
      note: 'one bag torn',
      photoUrl: 'https://cdn.example/p.jpg',
      receivedQty: '1.5',
    });
    expect(next[0]).toEqual({
      ...line('s1'),
      confirmStatus: 'short',
      confirmNote: 'one bag torn',
      confirmPhotoUrl: 'https://cdn.example/p.jpg',
      confirmReceivedQty: '1.5',
    });
    expect(next[1]).toBe(splits[1]);
    expect(next[2]).toBe(splits[2]);
    expect(splits[0]).toEqual(line('s1'));
  });

  it('an ok verdict clears what an earlier problem said', () => {
    const reported: ReturnType<typeof line> = {
      ...line('s1'),
      confirmStatus: 'short',
      confirmNote: 'x',
      confirmPhotoUrl: 'https://cdn.example/p.jpg',
      confirmReceivedQty: '1',
    };
    const [next] = withLineVerdict([reported], {
      runId: 'r1',
      skuId: 's1',
      storeId: 'A',
      status: 'ok',
      note: null,
      photoUrl: null,
    });
    expect(next).toEqual({ ...line('s1'), confirmStatus: 'ok' });
  });
});

describe('confirmMainButton (review CONF-07)', () => {
  const state = (patch: Partial<ConfirmMainButtonState> = {}): ConfirmMainButtonState => ({
    issue: null,
    finalOpen: false,
    confirming: false,
    markingAll: false,
    hasRun: true,
    lineCount: 3,
    undecided: 0,
    storeConfirmed: false,
    ...patch,
  });

  it('the open problem form drives its Save, even over the summary sheet', () => {
    expect(
      confirmMainButton(
        state({ issue: { canSave: true, waitingForPhoto: false }, finalOpen: true }),
      ),
    ).toEqual({
      action: 'saveIssue',
      label: { key: 'confirm.issue.save' },
      visible: true,
      active: true,
    });
    expect(confirmMainButton(state({ issue: { canSave: false, waitingForPhoto: true } }))).toEqual({
      action: 'saveIssue',
      label: { key: 'photo.uploading' },
      visible: true,
      active: false,
    });
  });

  it('U4: the summary sheet drives 确认收货', () => {
    expect(confirmMainButton(state({ finalOpen: true }))).toEqual({
      action: 'submitConfirm',
      label: { key: 'confirm.final.submit' },
      visible: true,
      active: true,
    });
    expect(confirmMainButton(state({ finalOpen: true, confirming: true }))).toMatchObject({
      label: { key: 'confirm.confirmingHint' },
      active: false,
    });
    expect(confirmMainButton(state({ finalOpen: true, undecided: 1 })).active).toBe(false);
  });

  it('2026-07-30: says how many lines still need a verdict instead of an inert 确认收货', () => {
    expect(confirmMainButton(state({ undecided: 2 }))).toEqual({
      action: 'openConfirm',
      label: { key: 'confirm.confirmStoreBlocked', vars: { n: 2 } },
      visible: true,
      active: false,
    });
    expect(confirmMainButton(state())).toEqual({
      action: 'openConfirm',
      label: { key: 'confirm.confirmStore' },
      visible: true,
      active: true,
    });
  });

  it('waits for a confirm or a mark-all on its way', () => {
    expect(confirmMainButton(state({ confirming: true }))).toMatchObject({
      label: { key: 'confirm.confirmingHint' },
      active: false,
    });
    expect(confirmMainButton(state({ markingAll: true })).active).toBe(false);
  });

  it('hides once signed, and with no run or nothing delivered', () => {
    expect(confirmMainButton(state({ storeConfirmed: true }))).toMatchObject({
      label: { key: 'confirm.confirmStoreFinal' },
      visible: false,
    });
    expect(confirmMainButton(state({ hasRun: false })).visible).toBe(false);
    expect(confirmMainButton(state({ lineCount: 0 }))).toMatchObject({
      visible: false,
      active: false,
    });
  });
});
