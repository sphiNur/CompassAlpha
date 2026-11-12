import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../shared/clock';
import { manager, orderStepper, sku, staff } from '../testing';
import { apply, emptyState, type OrderState } from './state';
import { decideSystem } from './system';

const NOW = new Date('2026-05-02T10:00:00Z');
const clock = fixedClock(NOW);
const { steps } = orderStepper(clock);
const RUN = 'run-1';

/** A submitted order with one line. */
function submitted(): OrderState {
  return steps(emptyState('sess-1'), [
    {
      type: 'StartDraft',
      orgId: 'org-1',
      storeId: 'store-1',
      orderDate: '2026-05-02',
      actor: staff(),
    },
    { type: 'AdjustItem', skuId: 'sku-1', qty: '1', sku: sku('sku-1'), actor: staff() },
    { type: 'Submit', actor: staff() },
  ]).state;
}

/** That order approved and put in run `runId`. */
function inRun(runId = RUN): OrderState {
  return steps(submitted(), [
    { type: 'Approve', actor: manager() },
    { type: 'AttachToRun', runId, actor: manager() },
  ]).state;
}

describe('order system commands (review ORD-07)', () => {
  test('an idle claim is released for the timeout, with no actor', () => {
    const claimed = steps(submitted(), [{ type: 'Claim', actor: manager() }]).state;
    const events = decideSystem(claimed, { type: 'ReleaseIdleClaim' }, clock);
    expect(events).toEqual([
      {
        streamId: 'sess-1',
        seq: claimed.seq + 1,
        occurredAt: NOW,
        actorUserId: null,
        actorMemberId: null,
        type: 'ClaimReleased',
        payload: { byMemberId: null, reason: 'timeout' },
      },
    ]);
    const after = events.reduce(apply, claimed);
    expect(after.claimedByMemberId).toBeNull();
    expect(after.status).toBe('submitted');
  });

  test('nothing to release when nobody holds the claim or the order has moved on', () => {
    expect(decideSystem(submitted(), { type: 'ReleaseIdleClaim' }, clock)).toEqual([]);
    const approved = steps(submitted(), [
      { type: 'Claim', actor: manager() },
      { type: 'Approve', actor: manager() },
    ]).state;
    expect(decideSystem(approved, { type: 'ReleaseIdleClaim' }, clock)).toEqual([]);
  });

  test('a finished run archives its orphaned session, keeping the run (audit CA-45)', () => {
    const session = inRun();
    const events = decideSystem(
      session,
      { type: 'RepairOrphan', runId: RUN, runStatus: 'finished' },
      clock,
    );
    expect(events).toEqual([
      {
        streamId: 'sess-1',
        seq: session.seq + 1,
        occurredAt: NOW,
        actorUserId: null,
        actorMemberId: null,
        type: 'Archived',
        payload: { reason: 'repair' },
      },
    ]);
    const after = events.reduce(apply, session);
    expect(after.status).toBe('archived');
    expect(after.runId).toBe(RUN);
  });

  test('a cancelled run sends its orphaned session back to approved', () => {
    const session = inRun();
    const events = decideSystem(
      session,
      { type: 'RepairOrphan', runId: RUN, runStatus: 'cancelled' },
      clock,
    );
    expect(events).toEqual([
      {
        streamId: 'sess-1',
        seq: session.seq + 1,
        occurredAt: NOW,
        actorUserId: null,
        actorMemberId: null,
        type: 'EjectedFromRun',
        payload: { runId: RUN, byMemberId: null, reason: 'repair' },
      },
    ]);
    const after = events.reduce(apply, session);
    expect(after.status).toBe('approved');
    expect(after.runId).toBeNull();
  });

  test('a session no longer in that run is left alone', () => {
    const repair = { type: 'RepairOrphan', runId: RUN, runStatus: 'cancelled' } as const;
    expect(decideSystem(inRun('run-2'), repair, clock)).toEqual([]);
    expect(decideSystem(submitted(), repair, clock)).toEqual([]);
    const archived = decideSystem(inRun(), { ...repair, runStatus: 'finished' }, clock).reduce(
      apply,
      inRun(),
    );
    expect(decideSystem(archived, { ...repair, runStatus: 'finished' }, clock)).toEqual([]);
  });
});
