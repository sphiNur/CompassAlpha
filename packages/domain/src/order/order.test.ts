import { describe, expect, test } from 'bun:test';
import { decide } from './commands';
import { apply, emptyState, replay, itemKey } from './state';
import type { OrderEvent } from './events';
import type { ActorCtx, SkuCtx } from './commands';
import { fixedClock } from '../shared/clock';

const NOW = new Date('2026-05-02T10:00:00Z');
const clock = fixedClock(NOW);

const sku = (id: string, step = '0.5'): SkuCtx => ({ id, step, unit: 'kg', isArchived: false });

const staff = (perms: string[] = ['order.draft', 'order.submit'], memberId = 'mem-staff-a'): ActorCtx => ({
  userId: `user-${memberId}`,
  memberId,
  permissions: new Set(perms),
  isClaimer: false,
});

const manager = (
  perms: string[] = ['order.claim', 'order.approve'],
  memberId = 'mem-mgr',
): ActorCtx => ({
  userId: `user-${memberId}`,
  memberId,
  permissions: new Set(perms),
  isClaimer: false,
});

function startedDraft(streamId = 'sess-1', actor: ActorCtx = staff()): typeof state {
  const state = emptyState(streamId);
  const events = decide(
    state,
    {
      type: 'StartDraft',
      orgId: 'org-1',
      storeId: 'store-1',
      orderDate: '2026-05-02',
      actor,
    },
    { clock },
  );
  return events.reduce(apply, state);
}

describe('order.decide (per-contributor lines)', () => {
  test('StartDraft records initiator', () => {
    const next = startedDraft();
    expect(next.status).toBe('draft');
    expect(next.initiatedByMemberId).toBe('mem-staff-a');
  });

  test('AdjustItem creates a row keyed by (sku, contributor)', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'sku-1', qty: '1.5', sku: sku('sku-1'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    const row = state.items.get(itemKey('sku-1', 'mem-staff-a'));
    expect(row?.qty).toBe('1.5');
    expect(row?.contributorMemberId).toBe('mem-staff-a');
    expect(row?.updatedByMemberId).toBe('mem-staff-a');
  });

  test('staff cannot edit a session owned by another staff', () => {
    // 0005: per-member ownership. memberA owns the session; memberB
    // tries to add a line to it and gets bounced.
    const memA = staff(['order.draft'], 'mem-A');
    const memB = staff(['order.draft'], 'mem-B');
    let state = startedDraft('sess-1', memA);
    expect(() =>
      decide(
        state,
        { type: 'AdjustItem', skuId: 'apple', qty: '3', sku: sku('apple'), actor: memB },
        { clock },
      ),
    ).toThrow('order.errors.notOwner');
    void state;
  });

  test('owner edits their own session normally', () => {
    const memA = staff(['order.draft'], 'mem-A');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '3', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    const a = state.items.get(itemKey('apple', 'mem-A'));
    expect(a?.qty).toBe('3');
  });

  test('manager CAN edit a staff’s session via targetMemberId mid-claim', () => {
    // Setup: staff A owns the session, submits, manager claims, then
    // adjusts via targetMemberId. The contributor stays = owner.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    const mgr = manager(['order.claim', 'order.approve'], 'mem-mgr');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '3', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: memA }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Claim', actor: mgr }, { clock }).reduce(apply, state);
    state = decide(
      state,
      {
        type: 'AdjustItem',
        skuId: 'apple',
        qty: '4',
        sku: sku('apple'),
        actor: { ...mgr, isClaimer: true },
        targetMemberId: 'mem-A',
      },
      { clock },
    ).reduce(apply, state);
    const row = state.items.get(itemKey('apple', 'mem-A'));
    expect(row?.qty).toBe('4');
    expect(row?.contributorMemberId).toBe('mem-A');
    expect(row?.updatedByMemberId).toBe('mem-mgr');
  });

  test('manager cannot create a line for a target who has no row yet', () => {
    // Even within the owner's session, manager edit via targetMemberId
    // requires the target row to exist.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    const mgr = manager(['order.claim', 'order.approve'], 'mem-mgr');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'banana', qty: '1', sku: sku('banana'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: memA }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Claim', actor: mgr }, { clock }).reduce(apply, state);
    expect(() =>
      decide(
        state,
        {
          type: 'AdjustItem',
          skuId: 'apple', // no row for apple yet
          qty: '4',
          sku: sku('apple'),
          actor: { ...mgr, isClaimer: true },
          targetMemberId: 'mem-A',
        },
        { clock },
      ),
    ).toThrow('order.errors.targetLineNotFound');
  });

  test('AdjustItem with same qty is a no-op', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'sku-1', qty: '1.5', sku: sku('sku-1'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    expect(
      decide(
        state,
        { type: 'AdjustItem', skuId: 'sku-1', qty: '1.5', sku: sku('sku-1'), actor: staff() },
        { clock },
      ),
    ).toEqual([]);
  });

  test('AdjustItem rejects qty not a multiple of step', () => {
    const state = startedDraft();
    expect(() =>
      decide(
        state,
        { type: 'AdjustItem', skuId: 'sku-1', qty: '0.3', sku: sku('sku-1'), actor: staff() },
        { clock },
      ),
    ).toThrow('order.errors.qtyNotMultipleOfStep');
  });

  test('Submit counts SKUs with non-zero qty', () => {
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '1', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    const out = decide(state, { type: 'Submit', actor: memA }, { clock });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('Submitted');
  });

  test('Submit fails when the owner has zeroed everything out', () => {
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '1', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '0', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    expect(() => decide(state, { type: 'Submit', actor: memA }, { clock })).toThrow(
      'order.errors.emptyOrder',
    );
  });

  test('Submit allowed when only extras present (no SKU rows) — M3.33 #6', () => {
    // Extras-only order: every line item is a "其他物品" entry, no
    // catalog SKU has been added. Before M3.33 this threw
    // 'emptyOrder'. Now the order can be submitted just on extras.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      {
        type: 'SetSessionExtras',
        extras: [{ name: '辣椒粉', qty: '200', unit: 'g' }],
        actor: memA,
      },
      { clock },
    ).reduce(apply, state);
    const events = decide(state, { type: 'Submit', actor: memA }, { clock });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('Submitted');
  });

  test('non-owner cannot submit even with order.submit perm', () => {
    // 0005 gate. Mode B keeps sessions private — only the owner can
    // submit. memberB has the perm but doesn't own this session.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    const memB = staff(['order.draft', 'order.submit'], 'mem-B');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '1', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    expect(() => decide(state, { type: 'Submit', actor: memB }, { clock })).toThrow(
      'order.errors.notOwner',
    );
  });

  test('full happy path: owner drafts + submits, manager approves', () => {
    // 0005: per-member sessions. The "two staff" case is now two
    // SEPARATE sessions; here we test the single-owner happy path.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '2', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'beef', qty: '1', sku: sku('beef'), actor: memA },
      { clock },
    ).reduce(apply, state);
    expect(state.items.size).toBe(2);
    state = decide(state, { type: 'Submit', actor: memA }, { clock }).reduce(apply, state);
    expect(state.status).toBe('submitted');
    expect(state.submittedByMemberId).toBe('mem-A');

    state = decide(state, { type: 'Claim', actor: manager() }, { clock }).reduce(apply, state);
    state = decide(
      state,
      { type: 'Approve', actor: { ...manager(), isClaimer: true } },
      { clock },
    ).reduce(apply, state);
    expect(state.status).toBe('approved');
  });

  test('claim by second manager fails when already claimed', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Claim', actor: manager() }, { clock }).reduce(apply, state);
    const otherMgr: ActorCtx = {
      userId: 'user-mgr2',
      memberId: 'mem-mgr2',
      permissions: new Set(['order.claim']),
      isClaimer: false,
    };
    expect(() => decide(state, { type: 'Claim', actor: otherMgr }, { clock })).toThrow(
      'order.errors.alreadyClaimed',
    );
  });

  test('release-claim by another approver succeeds and records override', () => {
    // 2026-05-18 escape valve: manager A claims, manager B (also has
    // order.approve) takes over because A went idle. Event records B as
    // byMemberId with reason='override' for audit. Without this, A's
    // stale claim would freeze the order indefinitely.
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    const mgrA = manager(['order.claim', 'order.approve'], 'mem-mgrA');
    state = decide(state, { type: 'Claim', actor: mgrA }, { clock }).reduce(apply, state);
    expect(state.claimedByMemberId).toBe('mem-mgrA');

    const mgrB = manager(['order.claim', 'order.approve'], 'mem-mgrB');
    const events = decide(
      state,
      { type: 'ReleaseClaim', reason: 'manual', actor: mgrB },
      { clock },
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('ClaimReleased');
    if (ev.type === 'ClaimReleased') {
      expect(ev.payload.byMemberId).toBe('mem-mgrB');
      expect(ev.payload.reason).toBe('override');
    }
    state = events.reduce(apply, state);
    expect(state.claimedByMemberId).toBeNull();
    expect(state.status).toBe('submitted'); // queue is unstuck, still awaits decision
  });

  test('release-claim by non-approver fails (claim-only role cannot force-release)', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    state = decide(
      state,
      { type: 'Claim', actor: manager(['order.claim', 'order.approve'], 'mem-mgrA') },
      { clock },
    ).reduce(apply, state);

    // mem-mgrC has order.claim but NOT order.approve — must not be able
    // to force-release somebody else's claim.
    const mgrC: ActorCtx = {
      userId: 'user-mgrC',
      memberId: 'mem-mgrC',
      permissions: new Set(['order.claim']),
      isClaimer: false,
    };
    expect(() =>
      decide(state, { type: 'ReleaseClaim', reason: 'manual', actor: mgrC }, { clock }),
    ).toThrow('order.errors.notClaimer');
  });

  test('release-claim by the claimer themselves keeps the original reason', () => {
    // Self-release path preserves command.reason — we want pagehide /
    // timeout / manual to round-trip through the event so downstream
    // consumers (audit views, analytics) can distinguish them.
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    const mgr = manager(['order.claim', 'order.approve'], 'mem-mgrA');
    state = decide(state, { type: 'Claim', actor: mgr }, { clock }).reduce(apply, state);
    const events = decide(
      state,
      { type: 'ReleaseClaim', reason: 'pagehide', actor: mgr },
      { clock },
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.type === 'ClaimReleased') {
      expect(ev.payload.byMemberId).toBe('mem-mgrA');
      expect(ev.payload.reason).toBe('pagehide');
    }
  });

  test('reject requires non-empty reason', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Claim', actor: manager() }, { clock }).reduce(apply, state);
    expect(() =>
      decide(
        state,
        { type: 'Reject', reason: '   ', actor: { ...manager(), isClaimer: true } },
        { clock },
      ),
    ).toThrow('order.errors.rejectReasonRequired');
  });

  test('withdraw allowed for the original submitter', () => {
    let state = startedDraft();
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: staff() },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: staff() }, { clock }).reduce(apply, state);
    expect(decide(state, { type: 'Withdraw', actor: staff() }, { clock })).toHaveLength(1);
  });

  test('withdraw rejected for non-owner without manager perm', () => {
    // 0005: each session has one owner. memberB has the perm but
    // doesn't own this session and isn't a manager — can't withdraw.
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    const memB = staff(['order.draft', 'order.submit'], 'mem-B');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 's', qty: '1', sku: sku('s'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: memA }, { clock }).reduce(apply, state);
    expect(() => decide(state, { type: 'Withdraw', actor: memB }, { clock })).toThrow(
      'order.errors.cannotWithdraw',
    );
  });

  test('replay yields identical state for a single-owner session', () => {
    // 0005: each session has one owner. Replaying the events produces
    // the same items.
    const state = emptyState('s1');
    const events: OrderEvent[] = [];
    const memA = staff(['order.draft'], 'mem-A');
    const e1 = decide(
      state,
      { type: 'StartDraft', orgId: 'o', storeId: 's', orderDate: '2026-05-02', actor: memA },
      { clock },
    );
    events.push(...e1);
    const after1 = e1.reduce(apply, state);
    const e2 = decide(
      after1,
      { type: 'AdjustItem', skuId: 'k', qty: '3', sku: sku('k'), actor: memA },
      { clock },
    );
    events.push(...e2);
    const after2 = e2.reduce(apply, after1);
    const e3 = decide(
      after2,
      { type: 'AdjustItem', skuId: 'apple', qty: '2', sku: sku('apple'), actor: memA },
      { clock },
    );
    events.push(...e3);
    const replayed = replay('s1', events);
    expect(replayed.items.get(itemKey('k', 'mem-A'))?.qty).toBe('3');
    expect(replayed.items.get(itemKey('apple', 'mem-A'))?.qty).toBe('2');
    expect(replayed.seq).toBe(events.length);
  });

  // -- Archive command (added 2026-05-03) -------------------------------
  // FinishRun cascades into Archive on each attached session. Sessions
  // that were already archived become a no-op (return []) so the cascade
  // is idempotent under retries.

  test('Archive flips an in_run session to archived', () => {
    let s = emptyState('s1');
    // Drive the session into in_run via the AttachToRun path.
    const me = staff(['order.draft', 'order.submit']);
    const mgr = manager(['order.claim', 'order.approve']);
    const evs: OrderEvent[] = [];
    function step(es: OrderEvent[]) {
      evs.push(...es);
      s = es.reduce(apply, s);
    }
    step(decide(s, { type: 'StartDraft', orgId: 'o', storeId: 'st', orderDate: '2026-05-02', actor: me }, { clock }));
    step(decide(s, { type: 'AdjustItem', skuId: 'k', qty: '3', sku: sku('k'), actor: me }, { clock }));
    step(decide(s, { type: 'Submit', actor: me }, { clock }));
    step(decide(s, { type: 'Claim', actor: { ...mgr, isClaimer: false } }, { clock }));
    step(decide(s, { type: 'Approve', actor: { ...mgr, isClaimer: true } }, { clock }));
    step(decide(s, { type: 'AttachToRun', runId: 'r1', actor: { ...mgr, isClaimer: true } }, { clock }));
    expect(s.status).toBe('in_run');
    const arch = decide(
      s,
      { type: 'Archive', reason: 'run_finished', actor: { ...mgr, isClaimer: true } },
      { clock },
    );
    expect(arch.length).toBe(1);
    expect(arch[0]!.type).toBe('Archived');
    s = arch.reduce(apply, s);
    expect(s.status).toBe('archived');
  });

  test('Archive on an already-archived session is a no-op', () => {
    // Build an archived state by feeding events directly.
    const archivedState = replay('s1', [
      { streamId: 's1', seq: 1, occurredAt: NOW, actorUserId: 'u', actorMemberId: 'm', type: 'DraftStarted', payload: { orgId: 'o', storeId: 'st', orderDate: '2026-05-02', initiatedByMemberId: 'm' } },
      { streamId: 's1', seq: 2, occurredAt: NOW, actorUserId: 'u', actorMemberId: 'm', type: 'Archived', payload: { reason: 'eod' } },
    ] as unknown as OrderEvent[]);
    expect(archivedState.status).toBe('archived');
    const out = decide(
      archivedState,
      { type: 'Archive', reason: 'run_finished', actor: staff() },
      { clock },
    );
    expect(out).toEqual([]);
  });

  test('Archive rejects from draft status', () => {
    let s = emptyState('s1');
    const me = staff();
    const evs = decide(
      s,
      { type: 'StartDraft', orgId: 'o', storeId: 'st', orderDate: '2026-05-02', actor: me },
      { clock },
    );
    s = evs.reduce(apply, s);
    expect(() =>
      decide(s, { type: 'Archive', reason: 'manual', actor: me }, { clock }),
    ).toThrow('order.errors.cannotArchive');
  });
});

// M1.8 (2026-05-07): session-level "其他物品" free-text note.
describe('order.SetSessionNote', () => {
  test('owner sets a session note in draft state', () => {
    const me = staff(['order.draft'], 'mem-A');
    let state = startedDraft('sess-1', me);
    const out = decide(
      state,
      { type: 'SetSessionNote', note: '  fresh bread, brand X  ', actor: me },
      { clock },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('SessionNoteSet');
    state = out.reduce(apply, state);
    // Trim is applied by the state reducer.
    expect(state.notes).toBe('fresh bread, brand X');
  });

  test('clearing the note (null / empty) results in null', () => {
    const me = staff(['order.draft'], 'mem-A');
    let state = startedDraft('sess-1', me);
    state = decide(
      state,
      { type: 'SetSessionNote', note: 'something', actor: me },
      { clock },
    ).reduce(apply, state);
    expect(state.notes).toBe('something');
    state = decide(
      state,
      { type: 'SetSessionNote', note: '   ', actor: me },
      { clock },
    ).reduce(apply, state);
    expect(state.notes).toBeNull();
  });

  test('idempotent — same value is a no-op', () => {
    const me = staff(['order.draft'], 'mem-A');
    let state = startedDraft('sess-1', me);
    state = decide(
      state,
      { type: 'SetSessionNote', note: 'apples please', actor: me },
      { clock },
    ).reduce(apply, state);
    const out = decide(
      state,
      { type: 'SetSessionNote', note: 'apples please', actor: me },
      { clock },
    );
    expect(out).toEqual([]);
  });

  test('non-owner cannot edit the session note in draft', () => {
    const memA = staff(['order.draft'], 'mem-A');
    const memB = staff(['order.draft'], 'mem-B');
    const state = startedDraft('sess-1', memA);
    expect(() =>
      decide(state, { type: 'SetSessionNote', note: 'foo', actor: memB }, { clock }),
    ).toThrow('order.errors.notOwner');
  });

  test('rejects notes over 1000 chars', () => {
    const me = staff(['order.draft'], 'mem-A');
    const state = startedDraft('sess-1', me);
    const huge = 'a'.repeat(1001);
    expect(() =>
      decide(state, { type: 'SetSessionNote', note: huge, actor: me }, { clock }),
    ).toThrow('order.errors.sessionNoteTooLong');
  });

  test('locked once the session is approved', () => {
    const memA = staff(['order.draft', 'order.submit'], 'mem-A');
    const mgr = manager(['order.claim', 'order.approve'], 'mem-mgr');
    let state = startedDraft('sess-1', memA);
    state = decide(
      state,
      { type: 'AdjustItem', skuId: 'apple', qty: '1', sku: sku('apple'), actor: memA },
      { clock },
    ).reduce(apply, state);
    state = decide(state, { type: 'Submit', actor: memA }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Claim', actor: mgr }, { clock }).reduce(apply, state);
    state = decide(state, { type: 'Approve', actor: mgr }, { clock }).reduce(apply, state);
    expect(() =>
      decide(state, { type: 'SetSessionNote', note: 'too late', actor: memA }, { clock }),
    ).toThrow('order.errors.lockedByStatus');
  });
});
