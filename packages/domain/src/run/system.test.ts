import { describe, expect, test } from 'bun:test';
import {
  RUN_CLOCK as clock,
  RUN_NOW as NOW,
  planAndPurchase,
  purchaser,
  runStepper,
} from '../testing';
import { applyRun } from './state';
import { decideRunSystem } from './system';

const { step } = runStepper(clock);

describe('run system commands (review ORD-07)', () => {
  test('an idle run claim is released for the timeout, with no actor', () => {
    const claimed = step(planAndPurchase(), { type: 'ClaimRun', actor: purchaser() });
    expect(claimed.claimedByMemberId).toBe('m1');
    const events = decideRunSystem(claimed, { type: 'ReleaseIdleClaim' }, clock);
    expect(events).toEqual([
      {
        streamId: 'run-1',
        seq: claimed.seq + 1,
        occurredAt: NOW,
        actorUserId: null,
        actorMemberId: null,
        type: 'RunClaimReleased',
        payload: { byMemberId: null, reason: 'timeout' },
      },
    ]);
    const after = events.reduce(applyRun, claimed);
    expect(after.claimedByMemberId).toBeNull();
    // A forced release remembers whose claim it ended, for the next banner.
    expect(after.previousClaimerMemberId).toBe('m1');
  });

  test('nothing to release when nobody holds the claim or the run has ended', () => {
    const run = planAndPurchase();
    expect(decideRunSystem(run, { type: 'ReleaseIdleClaim' }, clock)).toEqual([]);
    const claimed = step(run, { type: 'ClaimRun', actor: purchaser() });
    for (const status of ['finished', 'amending', 'cancelled'] as const) {
      expect(decideRunSystem({ ...claimed, status }, { type: 'ReleaseIdleClaim' }, clock)).toEqual(
        [],
      );
    }
  });
});
