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

describe('isPastBusinessDate (CA-25 offline replay)', () => {
  test('earlier day is past; same day and later are not', () => {
    expect(isPastBusinessDate('2026-10-20', '2026-10-21')).toBe(true);
    expect(isPastBusinessDate('2026-09-30', '2026-10-01')).toBe(true);
    expect(isPastBusinessDate('2026-10-21', '2026-10-21')).toBe(false);
    expect(isPastBusinessDate('2026-10-22', '2026-10-21')).toBe(false);
  });
});
