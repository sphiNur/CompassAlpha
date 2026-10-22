import { describe, expect, test } from 'bun:test';
import { decide } from './commands';
import { apply, emptyState } from './state';
import type { OrderEvent } from './events';
import type { ActorCtx, SkuCtx } from './commands';
import { changedByOthersSince, isPastBusinessDate } from './staleness';
import { fixedClock } from '../shared/clock';

const clock = fixedClock(new Date('2026-10-21T10:00:00Z'));
const sku: SkuCtx = { id: 'apple', step: '0.5', unit: 'kg', isArchived: false };
const actor = (memberId: string, perms: string[]): ActorCtx => ({
  userId: `user-${memberId}`,
  memberId,
  permissions: new Set(perms),
  isClaimer: false,
});
const staffA = actor('mem-A', ['order.draft', 'order.submit']);
const mgr = actor('mem-mgr', ['order.claim', 'order.approve']);

/** Run commands, collecting the appended events like the router does. */
function run(cmds: Array<(s: ReturnType<typeof emptyState>) => Parameters<typeof decide>[1]>) {
  let state = emptyState('sess-1');
  const events: OrderEvent[] = [];
  for (const mk of cmds) {
    for (const e of decide(state, mk(state), { clock })) {
      state = apply(state, e);
      events.push(e);
    }
  }
  return { state, events };
}

const submitted = [
  () => ({
    type: 'StartDraft' as const,
    orgId: 'org-1',
    storeId: 'store-1',
    orderDate: '2026-10-21',
    actor: staffA,
  }),
  () => ({ type: 'AdjustItem' as const, skuId: 'apple', qty: '1', sku, actor: staffA }),
  () => ({ type: 'Submit' as const, actor: staffA }),
];

describe('changedByOthersSince (CA-43 approve what you saw)', () => {
  test('nothing after the seen seq → not changed', () => {
    const { state, events } = run(submitted);
    expect(changedByOthersSince(events, state.seq, mgr.userId)).toBe(false);
  });

  test("the approver's own claim does not count as a change", () => {
    const seen = run(submitted).state.seq;
    const { events } = run([...submitted, () => ({ type: 'Claim' as const, actor: mgr })]);
    expect(changedByOthersSince(events, seen, mgr.userId)).toBe(false);
  });

  test('staff withdraw + edit + re-submit after the approver looked → changed', () => {
    const seen = run(submitted).state.seq;
    const { events } = run([
      ...submitted,
      () => ({ type: 'Withdraw' as const, actor: staffA }),
      () => ({ type: 'AdjustItem' as const, skuId: 'apple', qty: '5', sku, actor: staffA }),
      () => ({ type: 'Submit' as const, actor: staffA }),
    ]);
    expect(changedByOthersSince(events, seen, mgr.userId)).toBe(true);
  });

  test('system events (no actor) count as a change', () => {
    expect(changedByOthersSince([{ seq: 4, actorUserId: null }], 3, mgr.userId)).toBe(true);
  });

  test('events as read back from the store (actorMemberId null) still recognise the approver', () => {
    // eventStore.readStream returns actorMemberId: null; only actorUserId
    // survives persistence. The approver's own claim must not count.
    const seen = run(submitted).state.seq;
    const { events } = run([...submitted, () => ({ type: 'Claim' as const, actor: mgr })]);
    const persisted = events.map((e) => ({ ...e, actorMemberId: null }));
    expect(changedByOthersSince(persisted, seen, mgr.userId)).toBe(false);
  });
});

describe('changedByOthersSince — worker timeout release + re-claim', () => {
  const mgr2 = actor('mem-mgr2', ['order.claim', 'order.approve']);

  /** The worker's event: no actor, reason timeout (apps/worker releaseStaleClaims). */
  const timeoutRelease = (seq: number): OrderEvent => ({
    streamId: 'sess-1',
    seq,
    occurredAt: new Date('2026-10-21T10:31:00Z'),
    actorUserId: null,
    actorMemberId: null,
    type: 'ClaimReleased',
    payload: { byMemberId: null, reason: 'timeout' },
  });

  /** Append `claimer`'s claim after a timeout release of `holder`'s claim. */
  function timedOut(holder: ActorCtx, claimer: ActorCtx) {
    const claimed = run([...submitted, () => ({ type: 'Claim' as const, actor: holder })]);
    const seen = claimed.state.seq;
    const release = timeoutRelease(seen + 1);
    const state = apply(claimed.state, release);
    const reclaim = decide(state, { type: 'Claim', actor: claimer }, { clock });
    return { seen, events: [...claimed.events, release, ...reclaim] };
  }

  test('my claim timed out and I re-claimed it → not changed', () => {
    const { seen, events } = timedOut(mgr, mgr);
    expect(changedByOthersSince(events, seen, mgr.userId)).toBe(false);
  });

  test('works on events as read back from the store (actorMemberId null)', () => {
    const { seen, events } = timedOut(mgr, mgr);
    const persisted = events.map((e) => ({ ...e, actorMemberId: null }));
    expect(changedByOthersSince(persisted, seen, mgr.userId)).toBe(false);
  });

  test('someone else re-claimed after the timeout → changed', () => {
    const { seen, events } = timedOut(mgr, mgr2);
    expect(changedByOthersSince(events, seen, mgr.userId)).toBe(true);
  });

  test("another approver's claim timed out and I claimed → changed", () => {
    // The release ended someone else's claim, not mine.
    const { seen, events } = timedOut(mgr2, mgr);
    expect(changedByOthersSince(events, seen, mgr.userId)).toBe(true);
  });

  test('timeout release with no re-claim yet → changed', () => {
    const { seen, events } = timedOut(mgr, mgr);
    expect(changedByOthersSince(events.slice(0, -1), seen, mgr.userId)).toBe(true);
  });

  test('staff edits after my re-claim still count', () => {
    const { seen, events } = timedOut(mgr, mgr);
    const last = events[events.length - 1]!;
    const staffEdit = { ...last, seq: last.seq + 1, actorUserId: staffA.userId };
    expect(changedByOthersSince([...events, staffEdit], seen, mgr.userId)).toBe(true);
  });

  test('an override release by another approver still counts', () => {
    const claimed = run([...submitted, () => ({ type: 'Claim' as const, actor: mgr })]);
    const seen = claimed.state.seq;
    const override = decide(
      claimed.state,
      { type: 'ReleaseClaim', reason: 'manual', actor: mgr2 },
      {
        clock,
      },
    );
    const state = apply(claimed.state, override[0]!);
    const reclaim = decide(state, { type: 'Claim', actor: mgr }, { clock });
    expect(
      changedByOthersSince([...claimed.events, ...override, ...reclaim], seen, mgr.userId),
    ).toBe(true);
  });
});

describe('isPastBusinessDate (CA-25 offline replay)', () => {
  test('earlier day is past; same day and later are not', () => {
    expect(isPastBusinessDate('2026-10-20', '2026-10-21')).toBe(true);
    expect(isPastBusinessDate('2026-09-30', '2026-10-01')).toBe(true);
    expect(isPastBusinessDate('2026-10-21', '2026-10-21')).toBe(false);
    expect(isPastBusinessDate('2026-10-22', '2026-10-21')).toBe(false);
  });
});
